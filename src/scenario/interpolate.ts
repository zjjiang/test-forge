import { VAR_REF } from "./schema.js";

export type VarTable = Readonly<Record<string, unknown>>;

export class InterpolationError extends Error {
  constructor(
    readonly varName: string,
    readonly available: readonly string[],
  ) {
    super(
      `变量「${varName}」未定义。可用的变量：${available.length ? available.join(", ") : "（无）"}。` +
        `引用格式是 \${var:NAME}，NAME 只能是字母开头的字母/数字/下划线。`,
    );
    this.name = "InterpolationError";
  }
}

/** ${today:N}：本地时区今天偏移 N 天的 ISO 日期（YYYY-MM-DD），如 ${today:0}、${today:1}。 */
const TODAY_REF = /\$\{today:(-?\d+)\}/g;

const todayIso = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
};

/**
 * 插值字符串：
 * - ${var:NAME} 换成变量值（值转字符串；未定义直接报错，不静默留空）
 * - ${today:N} 换成相对日期，供爬虫库投喂等按当天日期造数的场景
 */
export function interpolate(raw: string, vars: VarTable): string {
  const withDates = raw.replace(TODAY_REF, (_whole, off: string) =>
    todayIso(Number(off)),
  );
  return withDates.replace(VAR_REF, (_whole, name: string) => {
    if (!(name in vars)) throw new InterpolationError(name, Object.keys(vars));
    const v = vars[name];
    if (v === null || v === undefined)
      throw new InterpolationError(name, Object.keys(vars));
    return String(v);
  });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 深度插值：字符串节点逐个替换，返回新对象，不改动入参。 */
export function interpolateDeep<T>(value: T, vars: VarTable): T {
  if (typeof value === "string")
    return interpolate(value, vars) as unknown as T;
  if (Array.isArray(value))
    return value.map((item) => interpolateDeep(item, vars)) as unknown as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, vars)]),
    ) as unknown as T;
  }
  return value;
}
