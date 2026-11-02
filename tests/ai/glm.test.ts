import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { aiConfigFrom, resolveAiEnv, testAi } from "../../src/ai/glm.js";
import { openStore, type Store } from "../../src/store/db.js";
import { setSetting } from "../../src/store/settings.js";

process.env.TESTFORGE_SECRET_KEY = process.env.TESTFORGE_SECRET_KEY ?? "a".repeat(64);

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function openStoreInMemory(): Store {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "tf-glm-"));
  return openStore(path.join(dir, "t.db"));
}

describe("resolveAiEnv 优先级", () => {
  it("全局 settings < 项目 var < 进程 env", () => {
    const store = openStoreInMemory();
    setSetting(store, "MIDSCENE_MODEL_NAME", "from-global");
    setSetting(store, "MIDSCENE_MODEL_API_KEY", "gk");
    const r = resolveAiEnv(store, { MIDSCENE_MODEL_NAME: "from-project" }, { MIDSCENE_MODEL_API_KEY: "from-env" });
    expect(r.MIDSCENE_MODEL_NAME).toBe("from-project");
    expect(r.MIDSCENE_MODEL_API_KEY).toBe("from-env");
    expect(r.MIDSCENE_MODEL_BASE_URL).toBeUndefined();
    store.close();
  });

  it("只保留 MIDSCENE_* 键", () => {
    const store = openStoreInMemory();
    const r = resolveAiEnv(store, { ADMIN_USER: "x", MIDSCENE_MODEL_NAME: "m" }, { PATH: "/bin" });
    expect(Object.keys(r)).toEqual(["MIDSCENE_MODEL_NAME"]);
    store.close();
  });
});

describe("aiConfigFrom", () => {
  it("family 缺省 anthropic", () => {
    expect(aiConfigFrom({}).family).toBe("anthropic");
    expect(aiConfigFrom({ MIDSCENE_MODEL_FAMILY: "openai" }).family).toBe("openai");
  });
});

describe("testAi", () => {
  const cfg = { family: "glm-v", model: "glm-4.6v", baseUrl: "https://gw.example/api", apiKey: "sk-1" };

  it("配置不完整直接失败", async () => {
    const r = await testAi({ family: "glm-v", model: "", baseUrl: "", apiKey: "" });
    expect(r.ok).toBe(false);
    expect(r.reply).toContain("配置不完整");
  });

  it("网关 200 时返回模型回复", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: " 正常 " } }],
    }), { status: 200 }));
    const r = await testAi(cfg, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("正常");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://gw.example/api/chat/completions");
    expect((call?.[1] as RequestInit | undefined)?.headers).toMatchObject({ authorization: "Bearer sk-1" });
  });

  it("HTTP 错误带出详情", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    const r = await testAi(cfg, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.reply).toContain("401");
    expect(r.reply).toContain("bad key");
  });

  it("网络异常带出错误消息", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await testAi(cfg, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.reply).toBe("ECONNREFUSED");
  });
});

describe("testAi anthropic 协议", () => {
  const cfg = { family: "anthropic", model: "glm-5.3", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "sk-1" };

  it("走 /v1/messages，x-api-key 鉴权，解析 content 块", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: "正常" }],
    }), { status: 200 }));
    const r = await testAi(cfg, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("正常");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
    const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    expect(headers?.["x-api-key"]).toBe("sk-1");
    expect(headers?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("baseUrl 是 anthropic 端点时即使 family 是 glm-v 也走 anthropic 协议", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
    }), { status: 200 }));
    const r = await testAi({ ...cfg, family: "glm-v" }, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/messages");
  });
});
