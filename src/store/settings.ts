import { decryptSecret, encryptSecret, getSecretKey, SECRET_MASK } from "./crypto.js";
import type { Store } from "./db.js";

/** 全局 AI（Midscene/GLM）配置的四个键，存 settings 表，随 run 执行时合成进 env。 */
export const AI_SETTING_KEYS = [
  "MIDSCENE_MODEL_FAMILY",
  "MIDSCENE_MODEL_NAME",
  "MIDSCENE_MODEL_BASE_URL",
  "MIDSCENE_MODEL_API_KEY",
] as const;

export type AiSettingKey = (typeof AI_SETTING_KEYS)[number];

const SECRET_KEYS: ReadonlySet<string> = new Set<string>(["MIDSCENE_MODEL_API_KEY"]);

export class SettingInputError extends Error {}

export interface AiSettingsView {
  configured: boolean;
  family: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  updatedAt: string;
}

function decode(r: Record<string, unknown>): { plain: string; isSecret: boolean } {
  const isSecret = Number(r.is_secret) === 1;
  const raw = r.value instanceof Buffer ? r.value : Buffer.from(String(r.value));
  const plain = isSecret ? decryptSecret(raw, getSecretKey()) : raw.toString("utf8");
  return { plain, isSecret };
}

export function setSetting(store: Store, key: string, value: string): void {
  if (!(AI_SETTING_KEYS as readonly string[]).includes(key)) {
    throw new SettingInputError(`unknown setting key: ${key}`);
  }
  const isSecret = SECRET_KEYS.has(key);
  const enc = isSecret ? encryptSecret(value, getSecretKey()) : Buffer.from(value, "utf8");
  const ts = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, is_secret=excluded.is_secret, updated_at=excluded.updated_at",
    )
    .run(key, enc, isSecret ? 1 : 0, ts);
}

/** 解密后的键值对，供 runner 合成 Midscene env。 */
export function aiSettingsEnv(store: Store): Record<string, string> {
  const rows = store.db.prepare("SELECT key, value, is_secret FROM settings").all() as Record<string, unknown>[];
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.key)] = decode(r).plain;
  return out;
}

/** 给 UI 的脱敏视图。 */
export function aiSettingsView(store: Store): AiSettingsView {
  const env = aiSettingsEnv(store);
  const model = env.MIDSCENE_MODEL_NAME ?? "";
  const baseUrl = env.MIDSCENE_MODEL_BASE_URL ?? "";
  const apiKey = env.MIDSCENE_MODEL_API_KEY ?? "";
  const rows = store.db.prepare("SELECT key, updated_at FROM settings").all() as Record<string, unknown>[];
  const updatedAt = rows.map((r) => String(r.updated_at)).sort().at(-1) ?? "";
  return {
    configured: model !== "" && baseUrl !== "" && apiKey !== "",
    family: env.MIDSCENE_MODEL_FAMILY ?? "glm-v",
    model,
    baseUrl,
    hasApiKey: apiKey !== "",
    apiKeyMasked: apiKey === "" ? "" : SECRET_MASK,
    updatedAt,
  };
}
