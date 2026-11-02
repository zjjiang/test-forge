import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenarios } from "../../src/scenario/loader.js";
import { readFile } from "node:fs/promises";

let dir: string;
afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("loader branches", () => {
  it("dir without yaml returns empty list", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tf-edge-"));
    const sub = path.join(dir, "empty");
    await mkdir(sub);
    const rs = await loadScenarios(sub);
    expect(rs).toEqual([]);
  });

  it("loadScenarios on nonexistent path throws stat error", async () => {
    await expect(loadScenarios(path.join(tmpdir(), "definitely-missing-tf"))).rejects.toThrow();
  });
});
