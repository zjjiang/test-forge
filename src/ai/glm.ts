import type { Store } from "../store/db.js";
import { aiSettingsEnv } from "../store/settings.js";

export const DEFAULT_AI_FAMILY = "anthropic";
export const DEFAULT_AI_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
export const DEFAULT_AI_MODEL = "glm-5.3";

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

/** anthropic 协议族（智谱 /api/anthropic 兼容端点）走 /v1/messages，其余走 OpenAI /chat/completions。 */
function isAnthropicProtocol(cfg: AiConfig): boolean {
  return /^(anthropic|claude)/i.test(cfg.family) || /\/api\/anthropic/.test(cfg.baseUrl);
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

  const anthropic = isAnthropicProtocol(cfg);
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const url = anthropic ? base + "/v1/messages" : base + "/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  let payload: unknown;
  if (anthropic) {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    payload = { model: cfg.model, max_tokens: 16, messages: [{ role: "user", content: "只回复两个字：正常" }] };
  } else {
    headers.authorization = "Bearer " + cfg.apiKey;
    payload = { model: cfg.model, messages: [{ role: "user", content: "只回复两个字：正常" }], temperature: 0, max_tokens: 16 };
  }
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = JSON.stringify(body)?.slice(0, 300) ?? "";
      return { ok: false, ms: Date.now() - started, reply: `HTTP ${res.status} ${detail}` };
    }
    const reply = anthropic ? anthropicReply(body) : openaiReply(body);
    return { ok: true, ms: Date.now() - started, reply: reply === "" ? "(空回复)" : reply.slice(0, 200) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, reply: e instanceof Error ? e.message : String(e) };
  }
}

function openaiReply(body: Record<string, unknown> | null): string {
  const choices = body?.choices as { message?: { content?: unknown } }[] | undefined;
  return String(choices?.[0]?.message?.content ?? "").trim();
}

function anthropicReply(body: Record<string, unknown> | null): string {
  const content = body?.content as { type?: unknown; text?: unknown }[] | undefined;
  return (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("")
    .trim();
}
