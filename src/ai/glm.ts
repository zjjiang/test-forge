import type { Store } from "../store/db.js";
import { aiSettingsEnv } from "../store/settings.js";

export const DEFAULT_AI_FAMILY = "glm-v";

export interface AiConfig {
  family: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface AiTestResult {
  ok: boolean;
  ms: number;
  reply: string;
}

const AI_KEY_RE = /^MIDSCENE_[A-Z_]+$/;

function pickAi(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (AI_KEY_RE.test(k) && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/**
 * 合成生效的 Midscene 配置：全局 settings < 项目 var（MIDSCENE_*）< 进程 env，
 * 越具体的来源优先级越高，后者覆盖前者。
 */
export function resolveAiEnv(
  store: Store,
  projectVars: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { ...aiSettingsEnv(store), ...pickAi(projectVars), ...pickAi(env) };
}

export function aiConfigFrom(env: Record<string, string | undefined>): AiConfig {
  return {
    family: env.MIDSCENE_MODEL_FAMILY ?? DEFAULT_AI_FAMILY,
    model: env.MIDSCENE_MODEL_NAME ?? "",
    baseUrl: env.MIDSCENE_MODEL_BASE_URL ?? "",
    apiKey: env.MIDSCENE_MODEL_API_KEY ?? "",
  };
}

/** 直连模型网关发一次真实补全请求，验证连通性；不启动浏览器。 */
export async function testAi(
  cfg: AiConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<AiTestResult> {
  const missing = [
    cfg.model === "" && "模型名",
    cfg.baseUrl === "" && "Base URL",
    cfg.apiKey === "" && "API Key",
  ].filter((x): x is string => typeof x === "string");
  if (missing.length > 0) return { ok: false, ms: 0, reply: "配置不完整：缺 " + missing.join("、") };

  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "只回复两个字：正常" }],
        temperature: 0,
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = JSON.stringify(body)?.slice(0, 300) ?? "";
      return { ok: false, ms: Date.now() - started, reply: `HTTP ${res.status} ${detail}` };
    }
    const choices = body?.choices as { message?: { content?: unknown } }[] | undefined;
    const reply = String(choices?.[0]?.message?.content ?? "").trim();
    return { ok: true, ms: Date.now() - started, reply: reply === "" ? "(空回复)" : reply.slice(0, 200) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, reply: e instanceof Error ? e.message : String(e) };
  }
}
