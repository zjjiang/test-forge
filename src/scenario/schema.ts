import { z } from "zod";

/** 变量引用形如 ${var:NAME}，见 interpolate.ts。带 g 标志供 replace 全量替换。 */
export const VAR_REF = /\$\{var:([A-Za-z][A-Za-z0-9_]*)\}/g;

const slugKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, "只允许小写字母开头，小写字母/数字/下划线/短横线");

const httpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const cookie = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
});

const mock = z
  .object({
    url: z.string().min(1),
    method: httpMethod.optional(),
    status: z.number().int().min(200).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    fixture: z.string().optional(),
    delayMs: z.number().int().min(0).max(60_000).optional(),
    abort: z.boolean().optional(),
  })
  .refine(
    (m) =>
      m.abort === true ||
      m.body !== undefined ||
      m.fixture !== undefined ||
      m.status !== undefined,
    { message: "mock 必须至少给出 body / fixture / status / abort 之一" },
  );

const stepCommon = {
  id: slugKey.optional(),
  /** 以哪个 actor 的上下文执行本步骤 */
  as: slugKey.optional(),
  /** 人话验收点，进报告作为该步截图的说明 */
  expect: z.string().max(200).optional(),
  /** warn：步骤失败时记录警告，场景不判失败 */
  onFail: z.enum(["fail", "warn"]).default("fail"),
  /** 覆盖场景级 stepTimeoutMs（navigate/wait/js_assert 等长步骤用） */
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
};

const stepSchema = z.discriminatedUnion("type", [
  z.object({
    ...stepCommon,
    type: z.literal("navigate"),
    url: z.string().min(1),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("click"),
    selector: z.string().min(1),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("fill"),
    selector: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("press"),
    key: z.string().min(1),
    selector: z.string().optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("wait"),
    ms: z.number().int().min(0).max(60_000).optional(),
    selector: z.string().optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("screenshot"),
    name: z.string().max(60).optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("ai_action"),
    instruction: z.string().min(1).max(500),
    retries: z.number().int().min(0).max(3).default(1),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("visual_assert"),
    expected: z.string().min(1).max(500),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("dom_assert"),
    selector: z.string().min(1),
    state: z
      .enum([
        "visible",
        "hidden",
        "attached",
        "detached",
        "enabled",
        "disabled",
        "checked",
      ])
      .optional(),
    text: z.string().optional(),
    contains: z.string().optional(),
    /** input/textarea 的当前值（精确匹配） */
    value: z.string().optional(),
    /** 匹配的元素个数（精确） */
    count: z.number().int().min(0).optional(),
    /** 匹配的元素个数下限 */
    countAtLeast: z.number().int().min(1).optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("select"),
    selector: z.string().min(1),
    /** option 的 value 属性 */
    value: z.string().optional(),
    /** option 的可见文本 */
    label: z.string().optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("hover"),
    selector: z.string().min(1),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("extract"),
    selector: z.string().min(1),
    /** 取属性值；缺省取 innerText */
    attr: z.string().optional(),
    /** 存入 run 内变量，后续步骤用 ${var:NAME} 引用 */
    into: slugKey,
  }),
  z.object({
    ...stepCommon,
    type: z.literal("http"),
    method: httpMethod,
    path: z.string().min(1),
    /** 表单编码请求体（复用 actor 登录态 cookie） */
    form: z.record(z.string(), z.string()).optional(),
    /** 不跟随重定向（断言 302 时用） */
    maxRedirects: z.number().int().min(0).max(20).optional(),
    expectStatus: z.number().int().min(200).max(599).optional(),
    expectJson: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("js_assert"),
    /** page.evaluate 的脚本：表达式或 () => value */
    script: z.string().min(1),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    contains: z.string().optional(),
    /** 结果为真值即通过 */
    truthy: z.boolean().optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("download"),
    /** 触发下载的点击 */
    click: z.string().min(1),
    namePrefix: z.string().optional(),
    nameSuffix: z.string().optional(),
    /** 下载文件首行需包含（CSV/xlsx 表头，只读文本文件） */
    headerContains: z.string().optional(),
  }),
  z.object({
    ...stepCommon,
    type: z.literal("api_assert"),
    method: httpMethod.optional(),
    url: z.string().min(1),
    expectStatus: z.number().int().min(200).max(599).optional(),
    expectJson: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  }),
]);

export const actorSchema = z.object({
  description: z.string().max(200).optional(),
  /** 原生 confirm/alert 处理：accept 自动接受（停用店铺等），缺省 dismiss */
  dialogs: z.enum(["accept", "dismiss"]).optional(),
  cookies: z.array(cookie).max(50).optional(),
  localStorage: z.record(z.string(), z.string()).optional(),
  sessionStorage: z.record(z.string(), z.string()).optional(),
  /** 挂到 window.__TEST_CONTEXT__ 的业务上下文 */
  initVars: z.record(z.string(), z.unknown()).optional(),
  clock: z.object({ now: z.string().min(4) }).optional(),
  mocks: z.array(mock).max(100).optional(),
});

export type ActorConfig = z.infer<typeof actorSchema>;

export const scenarioSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    version: z.number().int().min(1).default(1),
    /** 缺省时用项目配置的 baseUrl；场景里写baseUrl 可覆盖 */
    baseUrl: z.url().optional(),
    /** 缺少的 env 一律 skip 场景，例如 XK_COOKIE */
    requires: z.object({ env: z.array(z.string().min(1)).max(20) }).optional(),
    variables: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    actors: z
      .record(slugKey, actorSchema)
      .refine((a) => Object.keys(a).length >= 1, {
        message: "至少要有一个 actor",
      }),
    guards: z
      .object({
        blockedRoutes: z.array(z.string().min(1)).max(100).optional(),
        dataPrefix: z.string().max(40).optional(),
      })
      .optional(),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
    stepTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    steps: z.array(stepSchema).min(1),
    teardown: z.array(stepSchema).max(50).optional(),
  })
  .superRefine((s, ctx) => {
    const actorKeys = new Set(Object.keys(s.actors));
    const checkAs = (steps: z.infer<typeof stepSchema>[], where: string) => {
      steps.forEach((st, i) => {
        if (st.as !== undefined && !actorKeys.has(st.as)) {
          ctx.addIssue({
            code: "custom",
            path: [where, i, "as"],
            message: `未定义的 actor「${st.as}」`,
          });
        }
      });
    };
    checkAs(s.steps, "steps");
    checkAs(s.teardown ?? [], "teardown");
    // wait 的跨字段校验放在这里，保证 discriminated union 的分支都是纯 object
    const checkWait = (steps: z.infer<typeof stepSchema>[], where: string) => {
      steps.forEach((st, i) => {
        if (
          st.type === "wait" &&
          st.ms === undefined &&
          st.selector === undefined
        ) {
          ctx.addIssue({
            code: "custom",
            path: [where, i],
            message: "wait 需要 ms 或 selector 之一",
          });
        }
      });
    };
    checkWait(s.steps, "steps");
    checkWait(s.teardown ?? [], "teardown");
    // select 需要 value 或 label；js_assert 需要至少一种期望；extract 需要 as
    const checkSteps = (
      steps: z.infer<typeof stepSchema>[],
      where: string,
      rule: (st: z.infer<typeof stepSchema>) => string | null,
    ) => {
      steps.forEach((st, i) => {
        const msg = rule(st);
        if (msg !== null) ctx.addIssue({ code: "custom", path: [where, i], message: msg });
      });
    };
    const rules = [
      (st: z.infer<typeof stepSchema>): string | null =>
        st.type === "select" && st.value === undefined && st.label === undefined
          ? "select 需要 value 或 label 之一"
          : null,
      (st: z.infer<typeof stepSchema>): string | null =>
        st.type === "extract" && st.into === undefined
          ? "extract 需要 into（写入的变量名）"
          : null,
      (st: z.infer<typeof stepSchema>): string | null =>
        st.type === "js_assert" &&
        st.equals === undefined &&
        st.contains === undefined &&
        st.truthy === undefined
          ? "js_assert 需要 equals / contains / truthy 之一"
          : null,
    ];
    for (const rule of rules) {
      checkSteps(s.steps, "steps", rule);
      checkSteps(s.teardown ?? [], "teardown", rule);
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Mock = z.infer<typeof mock>;

export type ParseResult =
  { ok: true; scenario: Scenario } | { ok: false; issues: string[] };

/** 校验并返回人类可读的错误清单（不含抛异常） */
export function parseScenario(input: unknown): ParseResult {
  const r = scenarioSchema.safeParse(input);
  if (r.success) return { ok: true, scenario: r.data };
  const issues = r.error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return { ok: false, issues };
}
