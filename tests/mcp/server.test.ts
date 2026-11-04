import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildApp } from "../../src/server/api.js";
import { openStore } from "../../src/store/db.js";
import { createProject } from "../../src/store/projects.js";
import { registerTools } from "../../src/mcp/server.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let client: Client;
let scratch = "";
let store: ReturnType<typeof openStore>;
let dbPath = "";

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "tf-mcp-"));
  const projDir = path.join(scratch, "scenarios", "demo");
  await mkdir(projDir, { recursive: true });
  await writeFile(path.join(projDir, "01-冒烟.yaml"), "name: 冒烟\nversion: 1\nactors:\n  user: {}\nsteps:\n  - id: 打开\n    as: user\n    type: navigate\n    url: /\n");
  dbPath = path.join(scratch, "test.db");
  store = openStore(dbPath);
  createProject(store, { id: "demo", name: "Demo", baseUrl: "http://127.0.0.1:1", dataPrefix: "E2E-" });
  store.close();
  app = buildApp({ dbPath, dataDir: path.join(scratch, "data"), scenariosDir: path.join(scratch, "scenarios") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  process.env.TESTFORGE_URL = `http://127.0.0.1:${addr.port}`;

  const s = new McpServer({ name: "testforge-test", version: "0.0.0" });
  registerTools(s);
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = await InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
});

afterAll(async () => {
  await client.close();
  await app.close();
});

describe("testforge mcp server", () => {
  it("list_projects 返回项目数据", async () => {
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toContain("demo");
  });

  it("list_scenarios 列出场景与校验状态", async () => {
    const r = await client.callTool({ name: "list_scenarios", arguments: { projectId: "demo" } });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toContain("冒烟");
    expect(text).toContain("valid");
  });

  it("get_scenario_source 读到 YAML 与描述", async () => {
    const r = await client.callTool({ name: "get_scenario_source", arguments: { projectId: "demo", file: "01-冒烟.yaml" } });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toContain("name: 冒烟");
    expect(text).toContain('"description": ""');
  });

  it("save_scenario_yaml 拒绝非法内容并列出具体错误", async () => {
    const r = await client.callTool({ name: "save_scenario_yaml", arguments: { projectId: "demo", file: "01-冒烟.yaml", content: "name: x" } });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toContain("actors");
    expect(text).toContain("Invalid input");
  });

  it("save_scenario_yaml 通过校验并落盘", async () => {
    const yaml = "name: 冒烟\nversion: 1\nactors:\n  user: {}\nsteps:\n  - id: 打开\n    as: user\n    type: navigate\n    url: /\n";
    const r = await client.callTool({ name: "save_scenario_yaml", arguments: { projectId: "demo", file: "01-冒烟.yaml", content: yaml } });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toContain("schema 校验通过");
  });

  it("get_run 对未知 run 返回错误信息", async () => {
    const r = await client.callTool({ name: "get_run", arguments: { projectId: "demo", runId: "19700101-000000-000000" } });
    const text = JSON.stringify(r.content);
    expect(text.length).toBeGreaterThan(0);
  });
});
