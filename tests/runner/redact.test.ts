import { describe, expect, it } from "vitest";
import { makeRedactor } from "../../src/runner/redact.js";

describe("makeRedactor", () => {
  it("masks secret values in text", () => {
    const redact = makeRedactor({ PW: "hunter2", TOK: "abcdef" });
    const out = redact("login with hunter2 and tok=abcdef");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("********");
  });

  it("keeps short values (below 4 chars) unmasked", () => {
    const redact = makeRedactor({ X: "ab" });
    expect(redact("ab ab")).toBe("ab ab");
  });

  it("no secrets = identity", () => {
    expect(makeRedactor({})("plain")).toBe("plain");
  });
});
