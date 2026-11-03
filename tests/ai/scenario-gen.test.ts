import { describe, expect, it } from "vitest";
import { buildGenUserPrompt, generateScenarioYaml, SCHEMA_DOC, stripFences } from "../../src/ai/scenario-gen.js";

describe("stripFences", () => {
  it("纯 YAML 原样返回", () => {
    expect(stripFences("name: x\nsteps: []")).toBe("name: x\nsteps: []");
  });
  it("去掉 ```yaml 围栏", () => {
    expect(stripFences("```yaml\nname: x\n```")).toBe("name: x");
  });
  it("去掉无语言标注的围栏", () => {
    expect(stripFences("```\nname: x\n```")).toBe("name: x");
  });
});

describe("buildGenUserPrompt", () => {
  it("包含业务描述与现有 YAML", () => {
    const p = buildGenUserPrompt("测试登录", "name: 旧场景\n");
    expect(p).toContain("测试登录");
    expect(p).toContain("name: 旧场景");
    expect(p).toContain("只输出 YAML");
  });
  it("描述为空时提示按现有 YAML 优化", () => {
    expect(buildGenUserPrompt("  ", "")).toContain("业务描述为空");
  });
});

describe("SCHEMA_DOC", () => {
  it("覆盖 flow 与关键硬规则", () => {
    expect(SCHEMA_DOC).toContain("type: flow");
    expect(SCHEMA_DOC).toContain("E2E- 前缀");
    expect(SCHEMA_DOC).toContain("blockedRoutes");
  });
});

describe("generateScenarioYaml", () => {
  const cfg = {
    family: "anthropic",
    model: "glm-5.3",
    baseUrl: "https://gw.test/api/anthropic",
    apiKey: "k",
  };

  it("anthropic 协议：提取回复文本并去围栏", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "```yaml\nname: 新场景\n```" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const r = await generateScenarioYaml(cfg, "新增环节", "name: 旧\n", fetchImpl, 5000);
    expect(r.ok).toBe(true);
    expect(r.yaml).toBe("name: 新场景");
    expect(calls[0]?.url).toBe("https://gw.test/api/anthropic/v1/messages");
    const payload = calls[0]?.body as { system?: string; messages?: { content: string }[] };
    expect(payload.system).toContain("TestForge 场景 YAML 规范");
    expect(JSON.stringify(payload.messages)).toContain("新增环节");
  });

  it("openai 协议：走 /chat/completions", async () => {
    const cfg2 = { ...cfg, family: "openai", baseUrl: "https://gw.test/v1" };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "name: y" } }] }), { status: 200 })) as typeof fetch;
    const r = await generateScenarioYaml(cfg2, "d", "", fetchImpl, 5000);
    expect(r.ok).toBe(true);
    expect(r.yaml).toBe("name: y");
  });

  it("网关报错时返回错误信息", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as typeof fetch;
    const r = await generateScenarioYaml(cfg, "d", "", fetchImpl, 5000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("401");
  });

  it("配置不完整时直接返回错误，不发请求", async () => {
    const r = await generateScenarioYaml({ ...cfg, apiKey: "" }, "d", "", fetch, 5000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("API Key");
  });
});
