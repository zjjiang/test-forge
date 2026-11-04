import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../../src/store/db.js";
import { createProject, getProject } from "../../src/store/projects.js";
import { setVar } from "../../src/store/vars.js";
import { runScenario } from "../../src/runner/runner.js";
import { parseScenario } from "../../src/scenario/schema.js";
import type { Scenario } from "../../src/scenario/schema.js";

let server: http.Server;
let base: string;
let dataDir: string;
let store: Store;
let scratch: string;

const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>demo</title></head><body>
<h1 id="t">hotel demo</h1>
<button id="btn">book</button>
<div id="out" hidden>booked</div>
<script>
document.getElementById("btn").addEventListener("click", () => {
  fetch("/api/payment", { method: "POST" }).then((r) => { document.getElementById("out").hidden = false; });
});
</script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SITE);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
  scratch = await mkdtemp(path.join(tmpdir(), "tf-e2e-"));
  dataDir = path.join(scratch, "data");
});

afterAll(async () => {
  server.close();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  store = openStore(path.join(dataDir, "test.db"));
  if (getProject(store, "demo") === null) createProject(store, PROJ);
});

const PROJ = {
  id: "demo",
  name: "Demo",
  baseUrl: "http://placeholder",
  dataPrefix: "E2E-",
};

function makeScenario(): Scenario {
  const parsed = parseScenario({
    name: "冒烟场景",
    version: 1,
    baseUrl: base,
    actors: {
      user: {
        mocks: [
          {
            url: `*${base}/api/payment`,
            method: "POST",
            body: { payment_status: "success" },
          },
        ],
      },
    },
    guards: { blockedRoutes: [`${base}/health`], dataPrefix: "E2E-" },
    steps: [
      { type: "navigate", url: "/" },
      { type: "wait", selector: "#btn" },
      { type: "click", selector: "#btn" },
      { type: "dom_assert", selector: "#out", contains: "booked" },
      {
        type: "api_assert",
        url: "/api/payment",
        method: "POST",
        expectStatus: 200,
        expectJson: { payment_status: "success" },
      },
    ],
    teardown: [{ type: "navigate", url: "/health" }],
  });
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.scenario;
}

describe("runner e2e", () => {
  it("mocks, guards, teardown and evidence all work", async () => {
    const r = await runScenario({
      store,
      dataDir,
      projectId: "demo",
      scenario: makeScenario(),
      triggeredBy: "vitest",
    });
    if ("reason" in r) throw new Error("unexpected skip: " + r.reason);
    expect(
      r.status,
      JSON.stringify(
        r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]),
      ),
    ).toBe("passed");
    // evidence dir contents
    const files = await readdir(r.dir);
    expect(files).toContain("summary.json");
    expect(files).toContain("assertions.json");
    expect(files).toContain("execution.log");
    expect(files).toContain("report.html");
    expect(files).toContain("vars.json");
    expect(files).toContain("trace-user.zip");
    const shots = await readdir(path.join(r.dir, "screenshots"));
    expect(shots.length).toBeGreaterThan(0);
    const summary = JSON.parse(
      await readFile(path.join(r.dir, "summary.json"), "utf8"),
    );
    expect(summary.status).toBe("passed");
    const report = await readFile(path.join(r.dir, "report.html"), "utf8");
    expect(report).toContain("冒烟场景");
    expect(report).toContain("screenshots/");
    // guard blocked /health
    const log = await readFile(path.join(r.dir, "execution.log"), "utf8");
    expect(log).toContain("GUARD blocked");
    // teardown navigated and trace exists
    expect(summary.steps.length).toBe(makeScenario().steps.length + 1);
  });

  it("missing required env skips the scenario", async () => {
    const s = makeScenario();
    const r = await runScenario({
      store,
      dataDir,
      projectId: "demo",
      scenario: { ...s, requires: { env: ["DEFINITELY_MISSING_XYZ"] } },
      triggeredBy: "vitest",
    });
    if (!("reason" in r)) throw new Error("expected skip");
    expect(r.reason).toContain("DEFINITELY_MISSING_XYZ");
  });

  it(
    "requires.env 命中项目变量（secret）时不跳过",
    { timeout: 60000 },
    async () => {
      setVar(store, "demo", {
        key: "XK_COOKIE",
        value: "PHPSESSID=test",
        isSecret: true,
      });
      const s = makeScenario();
      const r = await runScenario({
        store,
        dataDir,
        projectId: "demo",
        scenario: { ...s, requires: { env: ["XK_COOKIE"] } },
        triggeredBy: "vitest",
      });
      if ("reason" in r) throw new Error("unexpected skip: " + r.reason);
      expect(
        r.status,
        JSON.stringify(
          r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]),
        ),
      ).toBe("passed");
    },
  );

  it("interpolation resolves project var and override", async () => {
    setVar(store, "demo", { key: "SHOP", value: "E2E-shop", isSecret: false });
    const s = makeScenario();
    const r = await runScenario({
      store,
      dataDir,
      projectId: "demo",
      scenario: {
        ...s,
        steps: [
          {
            type: "navigate",
            url: "/?shop=${var:SHOP}",
            onFail: "fail" as const,
          },
        ],
        teardown: [],
      },
      triggeredBy: "vitest",
    });
    if ("reason" in r) throw new Error(r.reason);
    expect(
      r.status,
      JSON.stringify(
        r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]),
      ),
    ).toBe("passed");
  });

  it(
    "failing fail-level step fails the run; warn-level does not",
    { timeout: 60000 },
    async () => {
      const s = makeScenario();
      const parsed = parseScenario({
        name: "失败路径",
        baseUrl: base,
        actors: { user: {} },
        steps: [
          { type: "navigate", url: "/", expect: "打开首页" },
          {
            type: "dom_assert",
            selector: "#nope",
            state: "visible",
            onFail: "warn",
            expect: "不存在的元素（warn）",
          },
          { type: "dom_assert", selector: "#t", contains: "hotel" },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.issues.join(";"));
      const r = await runScenario({
        store,
        dataDir,
        projectId: "demo",
        scenario: parsed.scenario,
        triggeredBy: "vitest",
      });
      if ("reason" in r) throw new Error(r.reason);
      expect(
        r.status,
        JSON.stringify(
          r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 120)]),
        ),
      ).toBe("passed");
      expect(r.warnings.length).toBeGreaterThan(0);
      const warned = r.steps.find((x) => x.status === "warned");
      expect(warned?.attempts.at(-1)?.ok).toBe(false);
    },
  );
});

describe("runner 新步骤类型", () => {
  it(
    "select/hover/extract/http/js_assert/download/内置变量全链路",
    { timeout: 60000 },
    async () => {
      // 动态页面：select 联动、登录表单、CSV 下载
      server.close();
      await new Promise<void>((ok) => {
        server = http.createServer((req, res) => {
          if (req.url === "/hotels/export") {
            res.writeHead(200, {
              "content-type": "text/csv",
              "content-disposition": 'attachment; filename="hotels_2026.csv"',
            });
            res.end("﻿酒店名称,城市\nE2E测试酒店,郑州\n");
            return;
          }
          if (req.url === "/settings/shop/create" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => {
              body += c;
            });
            req.on("end", () => {
              res.writeHead(403, { "content-type": "application/json" });
              res.end(JSON.stringify({ code: -1, message: "forbidden" }));
            });
            return;
          }
          if (req.url?.startsWith("/goto?")) {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(
              `<!doctype html><html><body><b id="who">${decodeURIComponent(req.url.slice(6))}</b></body></html>`,
            );
            return;
          }
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>demo2</title></head><body>
<h1 id="t">hotel demo</h1>
<select id="city" onchange="document.getElementById('picked').textContent='picked:'+this.value">
  <option value="">--</option><option value="郑州">郑州</option>
</select>
<div id="picked"></div>
<a id="dl" href="/hotels/export">导出</a>
<script>
document.getElementById("city").value = "";
</script>
</body></html>`);
        });
        server.listen(0, "127.0.0.1", ok);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      const base2 = `http://127.0.0.1:${addr.port}`;

      const parsed = parseScenario({
        name: "新步骤验证",
        baseUrl: base2,
        actors: { user: { dialogs: "accept" } },
        steps: [
          { type: "navigate", url: "/" },
          {
            type: "select",
            selector: "#city",
            value: "郑州",
            expect: "选择城市",
          },
          { type: "dom_assert", selector: "#picked", contains: "picked:郑州" },
          {
            type: "extract",
            selector: "#t",
            into: "title",
            expect: "提取标题",
          },
          {
            type: "download",
            click: "#dl",
            namePrefix: "hotels_",
            nameSuffix: ".csv",
            headerContains: "酒店名称",
            expect: "导出 CSV",
          },
          { type: "js_assert", script: "document.title", equals: "demo2" },
          { type: "js_assert", script: "1 > 2", truthy: false },
          {
            type: "http",
            method: "POST",
            path: "/settings/shop/create",
            form: { name: "x" },
            expectStatus: 403,
            expectJson: { code: -1 },
          },
          { type: "navigate", url: "/goto?${var:title}" },
          { type: "dom_assert", selector: "#who", contains: "hotel demo" },
          { type: "dom_assert", selector: "b", countAtLeast: 1 },
          {
            type: "js_assert",
            script: "document.querySelectorAll('h1').length",
            equals: 0,
          },
          { type: "wait", ms: 50, timeoutMs: 5000 },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.issues.join(";"));
      const r = await runScenario({
        store,
        dataDir,
        projectId: "demo",
        scenario: parsed.scenario,
        triggeredBy: "vitest",
      });
      if ("reason" in r) throw new Error(r.reason);
      expect(
        r.status,
        JSON.stringify(
          r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]),
        ),
      ).toBe("passed");
      const downloads = await readdir(path.join(r.dir, "downloads"));
      expect(
        downloads.some((f) => f.startsWith("hotels_") && f.endsWith(".csv")),
      ).toBe(true);
    },
  );
});

describe("runner flow 环节步骤", () => {
  it(
    "环节收敛子步骤：1 步出 1 图、断言逐条保留、子步骤记录进 summary",
    { timeout: 60000 },
    async () => {
      server.close();
      await new Promise<void>((ok) => {
        server = http.createServer((req, res) => {
          if (req.url === "/add" && req.method === "POST") {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!doctype html><html><body>
<div class="row" id="row-E2E酒店">E2E酒店</div>
<div id="count">1</div>
</body></html>`);
            return;
          }
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>flow demo</title></head><body>
<form onsubmit="event.preventDefault();fetch('/add',{method:'POST'}).then(r=>r.text()).then(h=>{document.open();document.write(h);document.close();})">
<input id="name" value="E2E酒店"><button id="save" type="submit">保存</button>
</form>
</body></html>`);
        });
        server.listen(0, "127.0.0.1", ok);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      const base3 = `http://127.0.0.1:${addr.port}`;

      const parsed = parseScenario({
        name: "环节验证",
        baseUrl: base3,
        actors: { user: {} },
        steps: [
          {
            type: "flow",
            id: "新增酒店环节",
            expect: "提交表单后列表出现新酒店",
            steps: [
              { type: "navigate", url: "/" },
              { type: "fill", selector: "#name", value: "E2E酒店" },
              { type: "click", selector: "#save", waitFor: "#row-E2E酒店" },
              { type: "extract", selector: "#count", into: "cnt" },
              {
                type: "js_assert",
                script: "document.querySelectorAll('.row').length",
                equals: 1,
              },
              {
                type: "js_assert",
                script: "document.getElementById('count').textContent",
                equals: "${var:cnt}",
              },
            ],
          },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.issues.join(";"));
      const r = await runScenario({
        store,
        dataDir,
        projectId: "demo",
        scenario: parsed.scenario,
        triggeredBy: "vitest",
      });
      if ("reason" in r) throw new Error(r.reason);
      expect(
        r.status,
        JSON.stringify(
          r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]),
        ),
      ).toBe("passed");
      // 场景只有 1 个顶层步骤
      expect(r.steps.length).toBe(1);
      const flow = r.steps[0]!;
      expect(flow.type).toBe("flow");
      // 子步骤全记录（navigate/fill/click/extract/js_assert×2）
      expect(flow.subSteps?.length).toBe(6);
      expect(flow.subSteps?.every((s) => s.status === "passed")).toBe(true);
      // 子步骤断言逐条保留在环节断言里（js_assert 的 ${var:cnt} 插值生效 → equals "1"）
      expect(flow.assertions.filter((a) => a.type === "js_assert").length).toBe(
        2,
      );
      // 只拍 1 张环节截图（子步骤的 after 截图被抑制）
      const shots = await readdir(path.join(r.dir, "screenshots"));
      expect(shots.length).toBe(1);
      expect(shots[0]).toContain("新增酒店环节");
      // summary.json 里也有 subSteps
      const summary = JSON.parse(
        await readFile(path.join(r.dir, "summary.json"), "utf8"),
      );
      expect(summary.steps[0].subSteps.length).toBe(6);
    },
  );

  it(
    "环节内子步骤失败 → 环节失败并留失败补拍",
    { timeout: 60000 },
    async () => {
      const parsed = parseScenario({
        name: "环节失败验证",
        baseUrl: base,
        actors: { user: {} },
        steps: [
          {
            type: "flow",
            id: "失败环节",
            steps: [
              { type: "navigate", url: "/" },
              { type: "dom_assert", selector: "#not-exist", state: "visible" },
              { type: "dom_assert", selector: "#btn", state: "visible" },
            ],
          },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.issues.join(";"));
      // base 服务可能已被上一个用例换掉，重建一个最简页面服务
      server.close();
      await new Promise<void>((ok) => {
        server = http.createServer((req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            '<!doctype html><html><body><button id="btn">go</button></body></html>',
          );
        });
        server.listen(0, "127.0.0.1", ok);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      const base4 = `http://127.0.0.1:${addr.port}`;
      const parsed2 = parseScenario({
        name: "环节失败验证",
        baseUrl: base4,
        actors: { user: {} },
        steps: parsed.scenario.steps,
      });
      if (!parsed2.ok) throw new Error(parsed2.issues.join(";"));
      const r = await runScenario({
        store,
        dataDir,
        projectId: "demo",
        scenario: parsed2.scenario,
        triggeredBy: "vitest",
      });
      if ("reason" in r) throw new Error(r.reason);
      expect(r.status).toBe("failed");
      const flow = r.steps[0]!;
      expect(flow.status).toBe("failed");
      expect(flow.subSteps?.[1]?.status).toBe("failed");
      expect(flow.subSteps?.[2]?.status).toBe("passed"); // 失败后继续跑后面的子步骤
      expect(flow.error).toContain("#not-exist");
      const shots = await readdir(path.join(r.dir, "screenshots"));
      expect(shots.some((f) => f.includes("fail"))).toBe(true);
    },
  );

  it(
    "flow 子步骤按 as 切换 actor 上下文（多身份隔离回归）",
    { timeout: 60000 },
    async () => {
      // 每个 actor 的 context 注入 __TEST_CONTEXT__.scenario = actor 名，用它当身份指纹
      server.close();
      await new Promise<void>((ok) => {
        server = http.createServer((req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>who</title></head><body>
<div id="who"></div>
<script>document.getElementById("who").textContent = (window.__TEST_CONTEXT__ || {}).scenario || "none";</script>
</body></html>`);
        });
        server.listen(0, "127.0.0.1", ok);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      const base5 = `http://127.0.0.1:${addr.port}`;
      const parsed = parseScenario({
        name: "身份隔离",
        baseUrl: base5,
        actors: { alpha: {}, beta: {} },
        steps: [
          {
            type: "flow",
            id: "切换身份环节",
            steps: [
              { type: "navigate", url: "/" },
              {
                type: "js_assert",
                script: 'document.getElementById("who").textContent',
                equals: "alpha",
              },
              { as: "beta", type: "navigate", url: "/" },
              {
                as: "beta",
                type: "js_assert",
                script: 'document.getElementById("who").textContent',
                equals: "beta",
              },
              { type: "navigate", url: "/" },
              {
                type: "js_assert",
                script: 'document.getElementById("who").textContent',
                equals: "alpha",
              },
            ],
          },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.issues.join(";"));
      const r = await runScenario({
        store,
        dataDir,
        projectId: "demo",
        scenario: parsed.scenario,
        triggeredBy: "vitest",
      });
      if ("reason" in r) throw new Error(r.reason);
      expect(
        r.status,
        JSON.stringify(
          r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 200)]),
        ),
      ).toBe("passed");
      const who = r.steps[0]!.assertions.filter((a) => a.type === "js_assert");
      expect(who.length).toBe(3);
      expect(
        who.every((a) => a.ok),
        JSON.stringify(
          who.map((a) => [a.stepId, a.expectedText, a.actualText]),
        ),
      ).toBe(true);
    },
  );
});
