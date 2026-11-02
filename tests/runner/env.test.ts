import { describe, expect, it } from "vitest";
import { routeMatcher, pickMock } from "../../src/runner/env.js";
import { assertApi } from "../../src/runner/actions.js";
import { parseScenario } from "../../src/scenario/schema.js";
import type { Step } from "../../src/scenario/schema.js";

describe("routeMatcher", () => {
  it("substring match without wildcard", () => {
    const m = routeMatcher("/api/hotels");
    expect(m(new URL("http://x/api/hotels?page=1"))).toBe(true);
    expect(m(new URL("http://x/other"))).toBe(false);
  });
  it("wildcard match", () => {
    const m = routeMatcher("*/api/*/detail");
    expect(m(new URL("http://x/api/hotels/detail"))).toBe(true);
    expect(m(new URL("http://x/api/hotels/list"))).toBe(false);
  });
});

describe("pickMock", () => {
  const mocks = [
    { url: "/api/a", method: "GET" },
    { url: "/api/a", method: "POST", body: {} },
  ];
  it("respects method", () => {
    expect(pickMock(mocks as never[], "post", "http://x/api/a")?.url).toBe("/api/a");
    expect(pickMock(mocks as never[], "PUT", "http://x/api/a")).toBeUndefined();
  });
});

function apiStep(partial: Record<string, unknown>): Step {
  const r = parseScenario({
    name: "t",
    actors: { u: {} },
    steps: [{ type: "api_assert", url: "/x", ...partial }],
  });
  if (!r.ok) throw new Error(r.issues.join(";"));
  const first = r.scenario.steps[0];
  if (first === undefined) throw new Error("no step");
  return first;
}

describe("assertApi", () => {
  const net = [
    { url: "http://x/api/pay", method: "POST", status: 200, body: '{"payment_status":"success"}' },
    { url: "http://x/api/pay", method: "GET", status: 500, body: null },
  ];
  it("status mismatch is reported", () => {
    const e = assertApi(net, apiStep({ method: "GET", expectStatus: 200 }) as never);
    expect(e).toContain("500");
  });
  it("json field subset is checked", () => {
    const e = assertApi(net, apiStep({ method: "POST", expectJson: { payment_status: "success" } }) as never);
    expect(e).toBe("");
  });
  it("no match reported", () => {
    const e = assertApi(net, apiStep({ url: "/nope" }) as never);
    expect(e).toContain("没有匹配");
  });
});

describe("pickMock edge", () => {
  it("method-less mock matches any method", () => {
    expect(pickMock([{ url: "/api/b" }] as never[], "DELETE", "http://x/api/b")?.url).toBe("/api/b");
  });
  it("delayed or abort mocks pass through pickMock", () => {
    expect(pickMock([{ url: "/api/c", delayMs: 10 }] as never[], "GET", "http://x/api/c")?.delayMs).toBe(10);
  });
});
