import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../../src/store/db.js";
import { aiSettingsEnv, aiSettingsView, setSetting, SettingInputError } from "../../src/store/settings.js";

process.env.TESTFORGE_SECRET_KEY = process.env.TESTFORGE_SECRET_KEY ?? "a".repeat(64);

let store: Store;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tf-settings-"));
  store = openStore(path.join(dir, "test.db"));
});

afterEach(() => store.close());
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("global AI settings", () => {
  it("写入后能解密读回，secret 不落明文", () => {
    setSetting(store, "MIDSCENE_MODEL_NAME", "glm-4.6v");
    setSetting(store, "MIDSCENE_MODEL_BASE_URL", "https://open.bigmodel.cn/api/paas/v4");
    setSetting(store, "MIDSCENE_MODEL_API_KEY", "sk-test-1234");
    setSetting(store, "MIDSCENE_MODEL_FAMILY", "glm-v");

    const env = aiSettingsEnv(store);
    expect(env.MIDSCENE_MODEL_NAME).toBe("glm-4.6v");
    expect(env.MIDSCENE_MODEL_API_KEY).toBe("sk-test-1234");

    const raw = store.db.prepare("SELECT value, is_secret FROM settings WHERE key = 'MIDSCENE_MODEL_API_KEY'").get() as { value: Buffer };
    expect(raw.value.toString("utf8")).not.toContain("sk-test-1234");

    const view = aiSettingsView(store);
    expect(view.configured).toBe(true);
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeyMasked).toBe("********");
    expect(view.model).toBe("glm-4.6v");
    expect(view.family).toBe("glm-v");
  });

  it("覆盖写入生效", () => {
    setSetting(store, "MIDSCENE_MODEL_NAME", "a");
    setSetting(store, "MIDSCENE_MODEL_NAME", "b");
    expect(aiSettingsEnv(store).MIDSCENE_MODEL_NAME).toBe("b");
  });

  it("空库时未配置，unknown key 报错", () => {
    expect(aiSettingsView(store).configured).toBe(false);
    expect(() => setSetting(store, "NOT_AI_KEY", "x")).toThrow(SettingInputError);
  });
});
