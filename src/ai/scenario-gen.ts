import { chatCompletion, type AiConfig } from "./glm.js";

/** TestForge 场景 YAML 的精简 schema 说明，作为生成提示词的一部分。 */
export const SCHEMA_DOC = `\
TestForge 场景 YAML 规范（必须严格遵守，产出物必须能通过 zod 校验）：

顶层字段：
- name: 场景名（中文，简短）
- description: 一句话说明
- version: 1
- baseUrl: 可省略（用项目配置）
- variables: 场景变量，值只能是字符串/数字/布尔；引用格式 \${var:NAME}（项目变量或内置 RUN_DATE/RUN_TIME/RUN_STAMP）
- actors: 至少 1 个，key 是小写 slug（如 admin、shop）。常用属性：description、dialogs: accept（自动接受原生 confirm）
- guards: { blockedRoutes: [URL模式] }，高危接口必须拦截（如 */maintain/push/run）
- steps: 业务环节列表（flow）；teardown: 收尾环节（同 flow，会保证执行）
- trace: false 用于超大 DOM 页面场景（可选）

步骤通用字段（stepCommon）：
- id: 中文、不能含空格、≤64字（用于展示与截图文件名）
- as: 用哪个 actor（必须是 actors 里已定义的 key）
- expect: 一句人话验收点
- onFail: warn（失败只记警告不判失败，已知缺陷取证用）
- timeoutMs: 覆盖默认 30s
- when: page.evaluate 脚本，假值时跳过本步

步骤类型（原子步骤）：
- navigate: { url, waitUntil?: load|domcontentloaded|networkidle }
- click: { selector, waitFor?: 点击后等待出现的选择器（弹窗等），出现后自动截图 }
- fill: { selector, value }
- press: { key, selector?: 先点击 }
- wait: { ms 或 selector 之一 }
- screenshot: { name? }
- select: { selector, value 或 label 之一, waitFor? }
- hover: { selector, waitFor? }
- extract: { selector, attr?, jsonField?, into: 变量名(slug) } — 存入运行时变量
- http: { method, path, form?, maxRedirects?, expectStatus?, expectJson? } — 复用 actor 登录态
- dom_assert: { selector, state?: visible|hidden|attached|detached|enabled|disabled|checked, text?, contains?, value?, count?, countAtLeast? }
- js_assert: { script(page.evaluate 脚本), equals | contains | truthy 之一 }
- api_assert: { url, method?, expectStatus?, expectJson? } — 匹配网络记录
- download: { click, namePrefix?, nameSuffix?, headerContains? }
- ai_action: { instruction } / visual_assert: { expected } — 需要 AI 配置

flow 环节步骤（steps 数组里用）：
- { id: 环节名(中文无空格), type: flow, expect: 一句话验收, steps: [原子子步骤×3~15] }
- 子步骤原样支持上述原子类型与通用字段（含 as/when/onFail）
- 子步骤不能嵌套 flow
- 环节结束自动拍一张全页截图，子步骤不要放纯 screenshot 步骤
- 一个场景收敛为 6~12 个环节；环节内动作→断言顺序排列

硬规则：
- 写操作只落 E2E- 前缀的测试数据（店铺名等带 \${var:RUN_STAMP} 保证幂等）
- 真实业务数据只读
- 高危接口（推送执行、批量确认、配置导入等）放进 guards.blockedRoutes
- 断言尽量确定性（dom_assert/js_assert/http），AI 断言只在视觉判断时用
- teardown 负责把测试数据停用留档，失败不判场景失败`;

/** 生成/优化场景 YAML 的用户提示词。 */
export function buildGenUserPrompt(description: string, currentYaml: string): string {
  const desc = description.trim() === "" ? "（业务描述为空，请根据现有 YAML 与规范优化）" : description.trim();
  const cur = currentYaml.trim() === ""
    ? "当前没有 YAML，请从零生成。"
    : `当前 YAML（在其基础上按业务描述优化；除非描述要求，不要删除已有断言）：\n\n\`\`\`yaml\n${currentYaml}\n\`\`\``;
  return `请根据下面的业务描述生成/优化 TestForge 场景 YAML。

## 业务描述
${desc}

## 现有配置
${cur}

## 要求
- 只输出 YAML 本身，不要 markdown 代码围栏，不要任何解释文字
- 严格符合 TestForge YAML 规范（见系统提示）
- 步骤 id 全部中文；环节（flow）6~12 个；断言逐条保留`;
}

/** 去掉模型回复里可能出现的 markdown 围栏，只留 YAML 正文。 */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:yaml|yml)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
  if (m !== null) return (m[1] ?? "").trim();
  return t;
}

export interface GenOutcome {
  ok: boolean;
  yaml: string;
  ms: number;
  error: string;
}

/** 调模型生成场景 YAML；返回的 YAML 未经校验，调用方须再走 parseScenario。 */
export async function generateScenarioYaml(
  cfg: AiConfig,
  description: string,
  currentYaml: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 240_000,
): Promise<GenOutcome> {
  const r = await chatCompletion(cfg, SCHEMA_DOC, buildGenUserPrompt(description, currentYaml), {
    fetchImpl,
    timeoutMs,
  });
  if (!r.ok) return { ok: false, yaml: "", ms: r.ms, error: r.text };
  const yaml = stripFences(r.text);
  if (yaml === "") return { ok: false, yaml: "", ms: r.ms, error: "模型返回为空" };
  return { ok: true, yaml, ms: r.ms, error: "" };
}

const DESC_DOC = `你是测试平台的业务描述助手。用户会给你一段场景的业务描述（Markdown），请把它优化成结构清晰、可直接指导 YAML 生成的版本：

结构模板：
# 场景名 业务描述
> 一句话说明场景目标

## 环节
1. **环节名**：动作概括；验收点（做什么、断言什么）
（列出全部环节，顺序合理）

## 边界与数据规则
- 测试数据约定（E2E 前缀等）、已知缺陷取证点、权限边界等

规则：
- 不发明用户没写的业务逻辑，不删除用户已有的检查点，只重排结构、补全表达、让验收点更具体
- 保持中文，保持 Markdown`;

export interface DescOutcome {
  ok: boolean;
  description: string;
  ms: number;
  error: string;
}

/** 优化业务描述（只改表达，不改业务内容）；返回 Markdown 文本。 */
export async function optimizeScenarioDescription(
  cfg: AiConfig,
  description: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<DescOutcome> {
  const r = await chatCompletion(cfg, DESC_DOC, `请优化下面的业务描述：\n\n${description}`, {
    fetchImpl,
    timeoutMs,
    maxTokens: 8000,
  });
  if (!r.ok) return { ok: false, description: "", ms: r.ms, error: r.text };
  const description2 = stripFences(r.text);
  if (description2 === "") return { ok: false, description: "", ms: r.ms, error: "模型返回为空" };
  return { ok: true, description: description2, ms: r.ms, error: "" };
}
