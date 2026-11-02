import { z } from "zod";

/** 变量引用形如 ${var:NAME}，见 interpolate.ts。带 g 标志供 replace 全量替换。 */
export const VAR_REF = /\$\{var:([A-Za-z][A-Za-z0-9_]*)\}/g;

const slugKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "只允许小写字母开头，小写字母/数字/下划线");

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
