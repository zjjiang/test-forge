import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, getSecretKey, SECRET_MASK } from "../../src/store/crypto.js";

beforeAll(() => {
  process.env.TESTFORGE_SECRET_KEY = process.env.TESTFORGE_SECRET_KEY ?? "a".repeat(64);
});

describe("crypto", () => {
  it("encrypt/decrypt roundtrip", () => {
    const key = getSecretKey();
    const blob = encryptSecret("hunter2", key);
    expect(blob.toString("latin1")).not.toContain("hunter2");
    expect(decryptSecret(blob, key)).toBe("hunter2");
  });

  it("unique IVs give unique ciphertexts", () => {
    const key = getSecretKey();
    expect(encryptSecret("v", key).toString("hex")).not.toBe(encryptSecret("v", key).toString("hex"));
  });

  it("wrong key fails authentication", () => {
    const blob = encryptSecret("v", getSecretKey());
    expect(() => decryptSecret(blob, Buffer.alloc(32, 9))).toThrow();
  });

  it("mask constant", () => {
    expect(SECRET_MASK).toBe("********");
  });
});
