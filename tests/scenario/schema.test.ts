import { describe, expect, it } from "vitest";
import { parseScenario } from "../../src/scenario/schema.js";

const base = {
  name: "VIP用户酒店预订",
  baseUrl: "http://localhost:4173",
  actors: {
    vip: { initVars: { user: { role: "vip" } } },
    admin: {},
  },
  steps: [
    { type: "navigate", url: "${var:BASE_URL}/hotels" },
    { type: "ai_action", instruction: "搜索东京的酒店" },
    { type: "visual_assert", expected: "页面显示VIP用户价格" },
  ],
};

describe("scenarioSchema", () => {
  it("接受合法的最小场景", () => {
    const r = parseScenario(base);
    expect(r.ok).toBe(true);
  });

  it("填充默认值：version=1、onFail=fail", () => {
    const r = parseScenario(base);
    if (!r.ok) throw new Error("应为合法场景");
    expect(r.scenario.version).toBe(1);
    expect(r.scenario.steps[1]?.onFail).toBe("fail");
  });

  it("ai_action 默认 retries=1", () => {
    const r = parseScenario(base);
    if (!r.ok) throw new Error("应为合法场景");
    const ai = r.scenario.steps.find((s) => s.type === "ai_action");
    expect(ai?.type === "ai_action" ? ai.retries : undefined).toBe(1);
  });

  it("拒绝未知步骤类型", () => {
    const r = parseScenario({ ...base, steps: [{ type: "teleport" }] });
    expect(r.ok).toBe(false);
  });

  it("拒绝未定义的 actor 引用", () => {
    const r = parseScenario({
      ...base,
      steps: [{ type: "click", selector: "#go", as: "ghost" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("ghost");
  });

  it("拒绝非法 baseUrl", () => {
    const r = parseScenario({ ...base, baseUrl: "不是URL" });
    expect(r.ok).toBe(false);
  });

  it("拒绝空 actors", () => {
    const r = parseScenario({ ...base, actors: {} });
    expect(r.ok).toBe(false);
  });

  it("teardown 里的 actor 引用同样校验", () => {
    const r = parseScenario({
      ...base,
      teardown: [{ type: "click", selector: "#x", as: "nobody" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(";")).toContain("teardown.0.as");
  });

  it("mock 必须给出响应来源之一", () => {
    const r = parseScenario({
      ...base,
      actors: { vip: { mocks: [{ url: "/api/hotels" }] } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.join(";")).toContain("body / fixture / status / abort");
  });

  it("wait 必须给出 ms 或 selector", () => {
    const r = parseScenario({ ...base, steps: [{ type: "wait" }] });
    expect(r.ok).toBe(false);
  });

  it("dom_assert 支持状态+文本组合", () => {
    const r = parseScenario({
      ...base,
      steps: [
        {
          type: "dom_assert",
          selector: ".pill",
          state: "visible",
          contains: "在营",
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("api_assert 带 expectJson 子集", () => {
    const r = parseScenario({
      ...base,
      steps: [
        {
          type: "api_assert",
          url: "/api/payment",
          method: "POST",
          expectStatus: 200,
          expectJson: { payment_status: "success" },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("flow 环节步骤校验", () => {
  const base = {
    name: "flow 校验",
    actors: { user: {} },
  };

  it("合法 flow 通过，子步骤规则同样生效", () => {
    const ok = parseScenario({
      ...base,
      steps: [
        {
          type: "flow",
          id: "环节一",
          steps: [
            { type: "navigate", url: "/" },
            { type: "js_assert", script: "true", truthy: true },
          ],
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it("flow 不能嵌 flow", () => {
    const bad = parseScenario({
      ...base,
      steps: [
        {
          type: "flow",
          steps: [{ type: "flow", steps: [{ type: "navigate", url: "/" }] }],
        } as never,
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it("flow 子步骤缺 select 的 value/label 时报错", () => {
    const bad = parseScenario({
      ...base,
      steps: [
        {
          type: "flow",
          steps: [{ type: "select", selector: "#s" }],
        },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join(";")).toContain("select 需要");
  });

  it("flow 子步骤引用未定义 actor 报错", () => {
    const bad = parseScenario({
      ...base,
      steps: [
        {
          type: "flow",
          steps: [{ type: "navigate", url: "/", as: "ghost" }],
        },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join(";")).toContain("ghost");
  });

  it("flow 至少要有一个子步骤", () => {
    const bad = parseScenario({
      ...base,
      steps: [{ type: "flow", steps: [] }],
    });
    expect(bad.ok).toBe(false);
  });
});
