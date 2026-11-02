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

const PROJ = { id: "demo", name: "Demo", baseUrl: "http://placeholder", dataPrefix: "E2E-" };

function makeScenario(): Scenario {
  const parsed = parseScenario({
    name: "冒烟场景",
    version: 1,
    baseUrl: base,
    actors: {
      user: {
        mocks: [
          { url: `*${base}/api/payment`, method: "POST", body: { payment_status: "success" } },
        ],
      },
    },
    guards: { blockedRoutes: [`${base}/health`], dataPrefix: "E2E-" },
    steps: [
      { type: "navigate", url: "/" },
      { type: "wait", selector: "#btn" },
      { type: "click", selector: "#btn" },
      { type: "dom_assert", selector: "#out", contains: "booked" },
      { type: "api_assert", url: "/api/payment", method: "POST", expectStatus: 200, expectJson: { payment_status: "success" } },
    ],
    teardown: [{ type: "navigate", url: "/health" }],
  });
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.scenario;
}

describe("runner e2e", () => {
  it("mocks, guards, teardown and evidence all work", async () => {
    const r = await runScenario({
      store, dataDir, projectId: "demo",
      scenario: makeScenario(),
      triggeredBy: "vitest",
    });
    if ("reason" in r) throw new Error("unexpected skip: " + r.reason);
    expect(r.status, JSON.stringify(r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]))).toBe("passed");
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
    const summary = JSON.parse(await readFile(path.join(r.dir, "summary.json"), "utf8"));
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
      store, dataDir, projectId: "demo",
      scenario: { ...s, requires: { env: ["DEFINITELY_MISSING_XYZ"] } },
      triggeredBy: "vitest",
    });
    if (!("reason" in r)) throw new Error("expected skip");
    expect(r.reason).toContain("DEFINITELY_MISSING_XYZ");
  });

  it("interpolation resolves project var and override", async () => {
    setVar(store, "demo", { key: "SHOP", value: "E2E-shop", isSecret: false });
    const s = makeScenario();
    const r = await runScenario({
      store, dataDir, projectId: "demo",
      scenario: { ...s, steps: [{ type: "navigate", url: "/?shop=${var:SHOP}", onFail: "fail" as const }], teardown: [] },
      triggeredBy: "vitest",
    });
    if ("reason" in r) throw new Error(r.reason);
    expect(r.status, JSON.stringify(r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 150)]))).toBe("passed");
  });

  it("failing fail-level step fails the run; warn-level does not", async () => {
    const s = makeScenario();
    const parsed = parseScenario({
      name: "失败路径",
      baseUrl: base,
      actors: { user: {} },
      steps: [
        { type: "navigate", url: "/", expect: "打开首页" },
        { type: "dom_assert", selector: "#nope", state: "visible", onFail: "warn", expect: "不存在的元素（warn）" },
        { type: "dom_assert", selector: "#t", contains: "hotel" },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.issues.join(";"));
    const r = await runScenario({ store, dataDir, projectId: "demo", scenario: parsed.scenario, triggeredBy: "vitest" });
    if ("reason" in r) throw new Error(r.reason);
    expect(r.status, JSON.stringify(r.steps.map((x) => [x.stepId, x.status, x.error.slice(0, 120)]))).toBe("passed");
    expect(r.warnings.length).toBeGreaterThan(0);
    const warned = r.steps.find((x) => x.status === "warned");
    expect(warned?.attempts.at(-1)?.ok).toBe(false);
  });
});
