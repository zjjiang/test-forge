import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  getSecretKey,
} from "../../src/store/crypto.js";
import { openStore, type Store } from "../../src/store/db.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  ProjectInputError,
} from "../../src/store/projects.js";
import {
  deleteVar,
  listVars,
  setVar,
  varSnapshot,
  VarInputError,
} from "../../src/store/vars.js";
import {
  createRun,
  finishRun,
  getRun,
  listRuns,
  newRunId,
} from "../../src/store/runs.js";

let store: Store;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tf-store-"));
  store = openStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const proj = {
  id: "htinns",
  name: "HTinns 新平台",
  baseUrl: "http://127.0.0.1:5005",
  blockedRoutes: ["/api/price/push"],
  dataPrefix: "E2E-",
};

describe("projects", () => {
  it("创建、读取、列出、删除项目", () => {
    createProject(store, proj);
    const got = getProject(store, "htinns");
    expect(got?.baseUrl).toBe("http://127.0.0.1:5005");
    expect(got?.blockedRoutes).toEqual(["/api/price/push"]);
    createProject(store, { ...proj, id: "demo", name: "Demo" });
    expect(listProjects(store).map((p) => p.id)).toEqual(["htinns", "demo"]);
    expect(deleteProject(store, "demo")).toBe(true);
    expect(getProject(store, "demo")).toBeNull();
  });

  it("拒绝非法 id / 空 name / 坏 baseUrl", () => {
    expect(() => createProject(store, { ...proj, id: "Bad_ID" })).toThrow(
      ProjectInputError,
    );
    expect(() =>
      createProject(store, { ...proj, id: "ok", name: "  " }),
    ).toThrow(ProjectInputError);
    expect(() =>
      createProject(store, { ...proj, id: "ok", baseUrl: "nope" }),
    ).toThrow(ProjectInputError);
  });

  it("更新项目走不可变合并", () => {
    createProject(store, proj);
    const updated = updateProject(store, "htinns", { name: "HTinns v2" });
    expect(updated.name).toBe("HTinns v2");
    expect(updated.blockedRoutes).toEqual(["/api/price/push"]);
  });
});

describe("vars", () => {
  beforeEach(() => createProject(store, proj));

  it("secret 加密落盘，列表只见掩码，快照拿得到原值", () => {
    setVar(store, "htinns", { key: "ADMIN_PW", value: "p@ss", isSecret: true });
    setVar(store, "htinns", {
      key: "BASE_URL",
      value: "http://x",
      isSecret: false,
    });
    const views = listVars(store, "htinns");
    const pw = views.find((v) => v.key === "ADMIN_PW");
    expect(pw?.value).toBe("********");
    expect(pw?.isSecret).toBe(true);
    const snap = varSnapshot(store, "htinns");
    expect(snap.values.ADMIN_PW).toBe("p@ss");
    expect(snap.redacted.ADMIN_PW).toBe("********");
  });

  it("密文确实不是明文", () => {
    setVar(store, "htinns", {
      key: "TOKEN",
      value: "plain-secret",
      isSecret: true,
    });
    const raw = store.db
      .prepare("SELECT value FROM vars WHERE key='TOKEN'")
      .get() as { value: Buffer };
    expect(raw.value.toString("latin1")).not.toContain("plain-secret");
    expect(decryptSecret(raw.value, getSecretKey())).toBe("plain-secret");
  });

  it("覆盖与删除", () => {
    setVar(store, "htinns", { key: "K", value: "1", isSecret: false });
    setVar(store, "htinns", { key: "K", value: "2", isSecret: false });
    expect(listVars(store, "htinns")[0]?.value).toBe("2");
    expect(deleteVar(store, "htinns", "K")).toBe(true);
    expect(listVars(store, "htinns")).toHaveLength(0);
  });

  it("非法 Key 报错", () => {
    expect(() =>
      setVar(store, "htinns", { key: "lower", value: "x", isSecret: false }),
    ).toThrow(VarInputError);
  });
});

describe("runs", () => {
  beforeEach(() => {
    createProject(store, proj);
    createProject(store, { ...proj, id: "demo", name: "Demo" });
  });

  it("run id 形如 20261102-142012-a1b2", () => {
    expect(newRunId(new Date("2026-11-02T14:20:12"))).toMatch(
      /^\d{8}-\d{6}-[0-9a-f]{4}$/,
    );
  });

  it("创建、完成、查询 run", async () => {
    const run = createRun(store, {
      projectId: "htinns",
      scenarioId: "SC01",
      scenarioName: "新店开通",
      triggeredBy: "claude-code",
    });
    expect(run.status).toBe("running");
    await new Promise((r) => setTimeout(r, 10));
    finishRun(store, run.id, "passed");
    const got = getRun(store, run.id);
    expect(got?.status).toBe("passed");
    expect(got?.durationMs).toBeGreaterThanOrEqual(0);
    expect(got?.finishedAt).not.toBe("");
  });

  it("按项目和场景过滤，倒序排列", async () => {
    const mk = (pid: string, sid: string) =>
      createRun(store, { projectId: pid, scenarioId: sid, scenarioName: sid });
    const r1 = mk("htinns", "SC01");
    await new Promise((r) => setTimeout(r, 5));
    mk("htinns", "SC02");
    await new Promise((r) => setTimeout(r, 5));
    mk("demo", "SC01");
    expect(
      listRuns(store, { projectId: "htinns" }).every(
        (r) => r.projectId === "htinns",
      ),
    ).toBe(true);
    expect(
      listRuns(store, { projectId: "htinns", scenarioId: "SC01" }).map(
        (r) => r.id,
      ),
    ).toEqual([r1.id]);
    expect(listRuns(store)[0]?.projectId).toBe("demo");
  });
});
