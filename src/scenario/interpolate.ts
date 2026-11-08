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

/** 点路径取值：a.b.c 逐层下钻；任一层缺名字段即按未定义变量报错。 */
export const resolveVarPath = (path: string, vars: VarTable): unknown => {
  const [root = "", ...rest] = path.split(".");
  if (!(root in vars)) throw new InterpolationError(root, Object.keys(vars));
  let cur: unknown = vars[root];
  for (const seg of rest) {
    if (cur === null || typeof cur !== "object") {
      throw new InterpolationError(path, Object.keys(vars));
    }
    const holder = cur as Record<string, unknown>;
    if (!(seg in holder)) throw new InterpolationError(path, Object.keys(vars));
    cur = holder[seg];
  }
  if (cur === null || cur === undefined)
    throw new InterpolationError(path, Object.keys(vars));
  return cur;
};

/**
 * 插值字符串：
 * - ${var:NAME} / ${var:NAME.field} 换成变量值（值转字符串；未定义直接报错，不静默留空）
 * - ${today:N} 换成相对日期，供爬虫库投喂等按当天日期造数的场景
 */
export function interpolate(raw: string, vars: VarTable): string {
  const withDates = raw.replace(TODAY_REF, (_whole, off: string) =>
    todayIso(Number(off)),
  );
  return withDates.replace(VAR_REF, (_whole, name: string) => {
    const v = resolveVarPath(name, vars);
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
