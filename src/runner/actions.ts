/// <reference lib="dom" />
import type { Locator, Page } from "playwright";
import type { Step } from "../scenario/schema.js";
import { interpolateDeep } from "../scenario/interpolate.js";
import type { NetworkEntry, ActorRuntime } from "./env.js";
import type {
  AssertionRecord,
  AttemptRecord,
  StepStatus,
  SubStepResult,
} from "./types.js";

export interface AIDriver {
  act(instruction: string, page: Page): Promise<void>;
  assert(expected: string, page: Page): Promise<boolean>;
}

/** db 步骤：直连 MySQL 执行只读查询，返回行集合（调用方负责断言）。 */
export async function queryDb(
  dsn: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(dsn);
  try {
    const [rows] = await conn.query(sql);
    return rows as Record<string, unknown>[];
  } finally {
    await conn.end().catch(() => undefined);
  }
}

export interface StepCtx {
  runtime: ActorRuntime;
  baseUrl: string;
  stepTimeoutMs: number;
  ai: AIDriver | null;
  log: (line: string) => void;
  shot: (
    label: string,
    phase: "before" | "after" | "fail",
    rt?: ActorRuntime,
  ) => Promise<void>;
  /** extract 步骤写 run 内变量，供后续步骤 ${var:NAME} 引用 */
  setVar: (name: string, value: string) => void;
  /** download 步骤的落盘位置（证据目录 downloads/ 下） */
  downloadPath: (suggestedName: string) => string;
  /** 当前变量快照（flow 子步骤执行时逐个重新插值用），可缺省 */
  stepVars?: () => Record<string, unknown>;
  /** 按 as 解析 actor runtime（缺省回退 flow 层 runtime），flow 子步骤切换身份用，可缺省 */
  runtimeFor?: (as: string | undefined) => ActorRuntime;
}

export interface StepOutcome {
  ok: boolean;
  /** when 条件为假时跳过：不判成败 */
  skipped?: boolean;
  error: string;
  attempts: AttemptRecord[];
  assertions: AssertionRecord[];
  /** type=flow 时：子步骤记录 */
  subSteps?: SubStepResult[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function record(
  out: StepOutcome,
  step: Step,
  kind: "det" | "ai",
  expected: string,
  actual: string,
  ok: boolean,
): void {
  out.assertions.push({
    stepId: step.id ?? step.type,
    type: step.type,
    kind,
    expectedText: expected,
    actualText: actual,
    ok,
    at: nowIso(),
  });
}

async function assertDom(
  page: Page,
  step: Extract<Step, { type: "dom_assert" }>,
): Promise<string> {
  if (step.count !== undefined || step.countAtLeast !== undefined) {
    const n = await page.locator(step.selector).count();
    if (step.count !== undefined && n !== step.count)
      return `元素个数期望 ${step.count}，实际 ${n}`;
    if (step.countAtLeast !== undefined && n < step.countAtLeast)
      return `元素个数期望 >= ${step.countAtLeast}，实际 ${n}`;
    return "";
  }
  const loc = page.locator(step.selector).first();
  if (step.value !== undefined) {
    await loc.waitFor({ state: "visible", timeout: step.timeoutMs ?? 5000 });
    const actual = await loc.inputValue().catch(() => "");
    if (actual !== step.value)
      return `输入值期望「${step.value}」实际「${actual}」`;
    return "";
  }
  if (step.state !== undefined) {
    if (step.state === "visible") {
      await loc
        .waitFor({ state: "visible", timeout: step.timeoutMs ?? 5000 })
        .catch(() => undefined);
    }
    const ok = await checkLocatorState(loc, step.state);
    return ok ? "" : `元素 ${step.selector} 不满足状态 ${step.state}`;
  }
  await loc.waitFor({ state: "visible", timeout: step.timeoutMs ?? 5000 });
  const text = await loc.innerText().catch(() => "");
  if (step.text !== undefined && text !== step.text) {
    return `文本不一致: 期望「${step.text}」实际「${text.trim()}」`;
  }
  if (step.contains !== undefined && !text.includes(step.contains)) {
    return `文本不包含「${step.contains}」，实际「${text.trim()}」`;
  }
  return "";
}

async function checkLocatorState(
  loc: Locator,
  state:
    | "visible"
    | "hidden"
    | "attached"
    | "detached"
    | "enabled"
    | "disabled"
    | "checked",
): Promise<boolean> {
  switch (state) {
    case "visible":
      return loc.isVisible();
    case "hidden":
      return loc.isHidden();
    case "attached":
      return (await loc.count()) > 0;
    case "detached":
      return (await loc.count()) === 0;
    case "enabled":
      return loc.isEnabled();
    case "disabled":
      return loc.isDisabled();
    case "checked":
      return loc.isChecked();
  }
}

export function assertApi(
  network: NetworkEntry[],
  step: Extract<Step, { type: "api_assert" }>,
): string {
  const matched = network.filter((e) => {
    const methodOk =
      step.method === undefined ||
      e.method.toUpperCase() === step.method.toUpperCase();
    return methodOk && e.url.includes(step.url);
  });
  if (matched.length === 0)
    return `网络记录中没有匹配 ${step.method ?? "*"} ${step.url}`;
  const errors: string[] = [];
  if (step.expectStatus !== undefined) {
    const statuses = matched.map((e) => e.status);
    if (!statuses.every((s) => s === step.expectStatus)) {
      errors.push(
        `状态码期望 ${step.expectStatus}，实际 ${statuses.join("/")}`,
      );
    }
  }
  if (step.expectJson !== undefined) {
    for (const e of matched) {
      if (e.body === null) continue;
      let json: unknown;
      try {
        json = JSON.parse(e.body);
      } catch {
        errors.push(`${e.url} 响应不是 JSON`);
        continue;
      }
      for (const [k, v] of Object.entries(step.expectJson)) {
        const actual = (json as Record<string, unknown>)?.[k];
        if (JSON.stringify(actual) !== JSON.stringify(v)) {
          errors.push(
            `${e.url} 字段 ${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  }
  return errors.join("; ");
}

/** htinns-test 的定格技巧：禁动画、等字体、留渲染余量，再全页截图。 */
export async function freezeAndShot(
  page: Page,
  filePath: string,
): Promise<boolean> {
  try {
    await page.evaluate(() => {
      if (document.getElementById("tf-noanim") === null) {
        const s = document.createElement("style");
        s.id = "tf-noanim";
        s.textContent =
          "*,*::before,*::after{animation:none !important;transition:none !important}";
        document.head.appendChild(s);
      }
      return document.fonts ? document.fonts.ready : null;
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: filePath, fullPage: true });
    return true;
  } catch {
    return false;
  }
}

export async function executeStep(
  step: Step,
  ctx: StepCtx,
): Promise<StepOutcome> {
  const out: StepOutcome = {
    ok: true,
    error: "",
    attempts: [],
    assertions: [],
  };
  const page = ctx.runtime.page;
  if (step.when !== undefined) {
    let ok = false;
    try {
      ok = Boolean(await page.evaluate(step.when));
    } catch (e) {
      out.ok = false;
      out.error = `when 条件执行失败: ${e instanceof Error ? e.message : String(e)}`;
      return out;
    }
    if (!ok) {
      out.skipped = true;
      record(
        out,
        step,
        "det",
        `when: ${step.when.slice(0, 100)}`,
        "条件为假，跳过",
        true,
      );
      return out;
    }
  }
  const t0 = Date.now();
  const attempt = async (n: number): Promise<boolean> => {
    const a0 = Date.now();
    try {
      switch (step.type) {
        case "navigate": {
          await page.goto(new URL(step.url, ctx.baseUrl).href, {
            waitUntil: step.waitUntil ?? "load",
            timeout: timeoutMs(step, ctx),
          });
          record(out, step, "det", `打开 ${step.url}`, page.url(), true);
          await ctx.shot(step.id ?? step.type, "after");
          return true;
        }
        case "click": {
          await page.click(step.selector, { timeout: ctx.stepTimeoutMs });
          if (step.waitFor !== undefined)
            await page.waitForSelector(step.waitFor, {
              timeout: timeoutMs(step, ctx),
              state: "visible",
            });
          record(out, step, "det", `点击 ${step.selector}`, "clicked", true);
          if (step.waitFor !== undefined)
            await ctx.shot(step.id ?? step.type, "after");
          return true;
        }
        case "fill": {
          await page.fill(step.selector, step.value, {
            timeout: ctx.stepTimeoutMs,
          });
          record(out, step, "det", `填写 ${step.selector}`, "filled", true);
          return true;
        }
        case "press": {
          if (step.selector !== undefined)
            await page.click(step.selector, { timeout: ctx.stepTimeoutMs });
          await page.keyboard.press(step.key);
          record(out, step, "det", `按键 ${step.key}`, "pressed", true);
          return true;
        }
        case "wait": {
          if (step.ms !== undefined) await page.waitForTimeout(step.ms);
          if (step.selector !== undefined)
            await page.waitForSelector(step.selector, {
              timeout: timeoutMs(step, ctx),
            });
          record(
            out,
            step,
            "det",
            step.selector ?? `${step.ms}ms`,
            "waited",
            true,
          );
          return true;
        }
        case "screenshot": {
          const label = step.name ?? step.id ?? "shot";
          await ctx.shot(label, "after");
          record(out, step, "det", "截图", label, true);
          return true;
        }
        case "dom_assert": {
          const err = await assertDom(page, step);
          record(
            out,
            step,
            "det",
            describeDomExpectation(step),
            err === "" ? "通过" : err,
            err === "",
          );
          return err === "";
        }
        case "api_assert": {
          const err = assertApi(ctx.runtime.network, step);
          record(
            out,
            step,
            "det",
            describeApiExpectation(step),
            err === "" ? "通过" : err,
            err === "",
          );
          return err === "";
        }
        case "ai_action": {
          if (ctx.ai === null)
            throw new Error("Midscene 未配置（缺 MIDSCENE_MODEL_* 环境变量）");
          await ctx.ai.act(step.instruction, page);
          record(out, step, "ai", step.instruction, "已执行", true);
          return true;
        }
        case "visual_assert": {
          if (ctx.ai === null)
            throw new Error("Midscene 未配置（缺 MIDSCENE_MODEL_* 环境变量）");
          const ok = await ctx.ai.assert(step.expected, page);
          record(
            out,
            step,
            "ai",
            step.expected,
            ok ? "AI 认为匹配" : "AI 认为不匹配",
            ok,
          );
          return ok;
        }
        case "select": {
          const opt =
            step.value !== undefined
              ? { value: step.value }
              : { label: step.label ?? "" };
          await page.selectOption(step.selector, opt, {
            timeout: ctx.stepTimeoutMs,
          });
          if (step.waitFor !== undefined)
            await page.waitForSelector(step.waitFor, {
              timeout: timeoutMs(step, ctx),
              state: "visible",
            });
          record(
            out,
            step,
            "det",
            `选择 ${step.selector}`,
            step.value !== undefined
              ? `value=${step.value}`
              : `label=${step.label}`,
            true,
          );
          if (step.waitFor !== undefined)
            await ctx.shot(step.id ?? step.type, "after");
          return true;
        }
        case "upload": {
          await page.setInputFiles(step.selector, step.path, {
            timeout: ctx.stepTimeoutMs,
          });
          if (step.waitFor !== undefined)
            await page.waitForSelector(step.waitFor, {
              timeout: timeoutMs(step, ctx),
              state: "visible",
            });
          record(out, step, "det", `上传 ${step.path}`, "uploaded", true);
          if (step.waitFor !== undefined)
            await ctx.shot(step.id ?? step.type, "after");
          return true;
        }
        case "hover": {
          await page.hover(step.selector, { timeout: ctx.stepTimeoutMs });
          if (step.waitFor !== undefined)
            await page.waitForSelector(step.waitFor, {
              timeout: timeoutMs(step, ctx),
              state: "visible",
            });
          record(out, step, "det", `悬停 ${step.selector}`, "hovered", true);
          if (step.waitFor !== undefined)
            await ctx.shot(step.id ?? step.type, "after");
          return true;
        }
        case "extract": {
          const loc = page.locator(step.selector).first();
          await loc.waitFor({
            state: "attached",
            timeout: timeoutMs(step, ctx),
          });
          const raw =
            step.attr !== undefined
              ? ((await loc.getAttribute(step.attr, {
                  timeout: timeoutMs(step, ctx),
                })) ?? "")
              : (await loc.innerText({ timeout: timeoutMs(step, ctx) })).trim();
          let value = raw;
          if (step.jsonField !== undefined) {
            try {
              const parsedJson: unknown = JSON.parse(raw);
              value = String(
                (parsedJson as Record<string, unknown>)?.[step.jsonField],
              );
            } catch {
              const msg = `extract jsonField=${step.jsonField}：值不是合法 JSON「${raw.slice(0, 120)}」`;
              record(
                out,
                step,
                "det",
                `提取 ${step.selector} → ${step.into}`,
                msg,
                false,
              );
              return false;
            }
          }
          ctx.setVar(step.into, value);
          record(
            out,
            step,
            "det",
            `提取 ${step.selector} → ${step.into}`,
            value,
            true,
          );
          return true;
        }
        case "http": {
          const url = new URL(step.path, ctx.baseUrl).href;
          const res = await ctx.runtime.context.request.fetch(url, {
            method: step.method,
            form: step.form,
            maxRedirects: step.maxRedirects,
            failOnStatusCode: false,
          });
          const status = res.status();
          const errors: string[] = [];
          if (step.expectStatus !== undefined && status !== step.expectStatus)
            errors.push(`状态码期望 ${step.expectStatus}，实际 ${status}`);
          if (step.expectJson !== undefined) {
            let json: Record<string, unknown> | null = null;
            try {
              json = (await res.json()) as Record<string, unknown>;
            } catch {
              errors.push("响应不是 JSON");
            }
            if (json !== null) {
              for (const [k, v] of Object.entries(step.expectJson)) {
                if (JSON.stringify(json[k]) !== JSON.stringify(v))
                  errors.push(
                    `字段 ${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(json[k])}`,
                  );
              }
            }
          }
          record(
            out,
            step,
            "det",
            `${step.method} ${step.path} → ${describeHttpExpect(step)}`,
            `HTTP ${status}${errors.length ? "；" + errors.join("; ") : ""}`,
            errors.length === 0,
          );
          return errors.length === 0;
        }
        case "db": {
          let rows: Record<string, unknown>[] = [];
          try {
            rows = await queryDb(step.dsn, step.sql);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            record(
              out,
              step,
              "det",
              "执行 SQL 查询",
              `连接/查询失败：${msg.slice(0, 200)}`,
              false,
            );
            return false;
          }
          const n = rows.length;
          const minOk = step.minRows === undefined ? true : n >= step.minRows;
          const notes: string[] = [];
          let assertsOk = true;
          for (const a of step.asserts ?? []) {
            const v = rows[0]?.[a.column];
            const s = v === undefined || v === null ? "" : String(v);
            let pass: boolean;
            let expectText: string;
            if (a.equals !== undefined) {
              pass = s === a.equals;
              expectText = "=" + a.equals;
            } else if (a.gte !== undefined) {
              const num = Number(s);
              pass = Number.isFinite(num) && num >= Number(a.gte);
              expectText = "≥" + a.gte;
            } else {
              pass = s.includes(a.contains ?? "");
              expectText = "包含 " + JSON.stringify(a.contains);
            }
            if (!pass) assertsOk = false;
            notes.push(
              `${a.column} ${expectText} → ${pass ? "✓" : "✗ 实际 " + JSON.stringify(s.slice(0, 160))}`,
            );
          }
          const ok = minOk && assertsOk;
          record(
            out,
            step,
            "det",
            `SQL 查询（minRows=${step.minRows ?? "—"}，字段断言 ${step.asserts?.length ?? 0} 条）`,
            `返回 ${n} 行${n > 0 ? `；首行 ${JSON.stringify(rows[0]).slice(0, 240)}` : ""}${notes.length ? "；" + notes.join("；") : ""}`,
            ok,
          );
          return ok;
        }
        case "js_assert": {
          const deadline = Date.now() + timeoutMs(step, ctx);
          let last = "";
          let first = true;
          for (;;) {
            if (step.reload === true && !first)
              await page.reload({ timeout: timeoutMs(step, ctx) });
            first = false;
            let value: unknown;
            try {
              value = await page.evaluate(step.script);
            } catch {
              // 导航进行中等瞬态错误：按可重试处理（限时内继续轮询）
              if (Date.now() >= deadline) {
                record(
                  out,
                  step,
                  "det",
                  describeJsExpectation(step),
                  "页面导航中无法求值（超时）",
                  false,
                );
                return false;
              }
              await page.waitForTimeout(500);
              continue;
            }
            last = describeJsValue(value);
            if (jsAssertionOk(value, step)) {
              record(out, step, "det", describeJsExpectation(step), last, true);
              return true;
            }
            if (Date.now() >= deadline) {
              record(
                out,
                step,
                "det",
                describeJsExpectation(step),
                last,
                false,
              );
              return false;
            }
            await page.waitForTimeout(500);
          }
        }
        case "flow": {
          /* 环节：原子子步骤逐个跑；子步骤只留失败补拍，环节结束拍一张总结截图 */
          const subs: SubStepResult[] = [];
          let allOk = true;
          let firstError = "";
          let lastRt: ActorRuntime | undefined;
          for (let j = 0; j < step.steps.length; j++) {
            const raw: Step = step.steps[j]!;
            // 子步骤按自己的 as 切换 actor 上下文（缺省回退 flow 层 runtime）
            const subRt =
              ctx.runtimeFor !== undefined
                ? ctx.runtimeFor(raw.as)
                : ctx.runtime;
            lastRt = subRt;
            const subCtx: StepCtx = {
              ...ctx,
              runtime: subRt,
              shot: async (label, phase) => {
                if (phase === "fail") await ctx.shot(label, "fail", subRt);
              },
            };
            let inst: Step = raw;
            let preError = "";
            if (ctx.stepVars !== undefined) {
              try {
                inst = interpolateDeep(raw, ctx.stepVars()) as Step;
              } catch (e) {
                preError = e instanceof Error ? e.message : String(e);
              }
            }
            const subId = raw.id ?? `${raw.type}-${j + 1}`;
            if (preError !== "") {
              subs.push({
                stepId: subId,
                type: raw.type,
                status: raw.onFail === "warn" ? "warned" : "failed",
                error: preError,
                ms: 0,
                assertions: [],
              });
              if (raw.onFail === "warn") continue;
              allOk = false;
              if (firstError === "") firstError = `${subId}: ${preError}`;
              continue;
            }
            const r = await executeStep(inst, subCtx);
            const subStatus: StepStatus =
              r.skipped === true
                ? "skipped"
                : r.ok
                  ? "passed"
                  : raw.onFail === "warn"
                    ? "warned"
                    : "failed";
            subs.push({
              stepId: subId,
              type: raw.type,
              status: subStatus,
              error: r.ok ? "" : r.error,
              ms: r.attempts.reduce((s, a) => s + a.ms, 0),
              assertions: r.assertions,
            });
            out.assertions.push(...r.assertions);
            if (subStatus === "failed") {
              allOk = false;
              if (firstError === "") firstError = `${subId}: ${r.error}`;
            }
          }
          // 环节总结截图跟随最后一个子步骤的身份（混合 actor 环节里展示谁的操作谁收尾的画面）
          if (allOk) await ctx.shot(step.id ?? step.type, "after", lastRt);
          record(
            out,
            step,
            "det",
            `环节共 ${step.steps.length} 个子步骤`,
            allOk ? "全部通过" : `存在失败：${firstError}`,
            allOk,
          );
          out.error = allOk ? "" : firstError;
          out.subSteps = subs;
          return allOk;
        }
        case "download": {
          const downloadPromise = page.waitForEvent("download", {
            timeout: timeoutMs(step, ctx),
          });
          downloadPromise.catch(() => {
            /* click 先失败时这里会超时拒绝，避免 unhandled rejection */
          });
          await page.click(step.click, { timeout: ctx.stepTimeoutMs });
          const dl = await downloadPromise;
          const fname = dl.suggestedFilename();
          const saveTo = ctx.downloadPath(fname);
          await dl.saveAs(saveTo);
          const errors: string[] = [];
          if (
            step.namePrefix !== undefined &&
            !fname.startsWith(step.namePrefix)
          )
            errors.push(
              `文件名期望前缀「${step.namePrefix}」，实际「${fname}」`,
            );
          if (step.nameSuffix !== undefined && !fname.endsWith(step.nameSuffix))
            errors.push(
              `文件名期望后缀「${step.nameSuffix}」，实际「${fname}」`,
            );
          if (step.headerContains !== undefined) {
            const { readFile } = await import("node:fs/promises");
            const firstLine =
              (await readFile(saveTo, "utf8")).split(/\r?\n/)[0] ?? "";
            if (!firstLine.includes(step.headerContains))
              errors.push(
                `首行期望包含「${step.headerContains}」，实际「${firstLine.slice(0, 120)}」`,
              );
          }
          record(
            out,
            step,
            "det",
            describeDownloadExpect(step),
            `下载 ${fname}${errors.length ? "；" + errors.join("; ") : ""}`,
            errors.length === 0,
          );
          return errors.length === 0;
        }
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  };

  const maxAttempts = step.type === "ai_action" ? step.retries + 1 : 1;
  for (let n = 1; n <= maxAttempts; n++) {
    const a0 = Date.now();
    const ok = await attempt(n);
    out.attempts.push({
      n,
      ok,
      error: ok ? "" : out.error,
      ms: Date.now() - a0,
    });
    if (ok) break;
  }
  const last = out.attempts.at(-1);
  if (last !== undefined && !last.ok) {
    out.ok = false;
    if (out.error === "") {
      const bad = out.assertions.filter((a) => !a.ok).at(-1);
      out.error =
        bad !== undefined
          ? `${bad.expectedText} → ${bad.actualText}`
          : "步骤未通过";
    }
    await ctx.shot(step.id ?? step.type, "fail");
  }
  ctx.log(
    `STEP ${step.id ?? step.type} ${out.ok ? "ok" : "fail"} (${Date.now() - t0}ms)`,
  );
  return out;
}

function timeoutMs(step: Step, ctx: StepCtx): number {
  return step.timeoutMs ?? ctx.stepTimeoutMs;
}

function describeHttpExpect(step: Extract<Step, { type: "http" }>): string {
  const parts: string[] = [];
  if (step.expectStatus !== undefined)
    parts.push(`status=${step.expectStatus}`);
  if (step.expectJson !== undefined)
    parts.push(`json=${JSON.stringify(step.expectJson)}`);
  return parts.length ? parts.join(" ") : "记录状态";
}

function describeJsExpectation(
  step: Extract<Step, { type: "js_assert" }>,
): string {
  const parts = [step.script.slice(0, 120)];
  if (step.equals !== undefined)
    parts.push(`equals=${JSON.stringify(step.equals)}`);
  if (step.contains !== undefined) parts.push(`contains=${step.contains}`);
  if (step.truthy !== undefined) parts.push("truthy");
  return parts.join(" ");
}

function describeJsValue(value: unknown): string {
  if (typeof value === "string")
    return value.length > 200 ? value.slice(0, 200) + "…" : value;
  return JSON.stringify(value) ?? String(value);
}

function jsAssertionOk(
  value: unknown,
  step: Extract<Step, { type: "js_assert" }>,
): boolean {
  if (step.equals !== undefined)
    return JSON.stringify(value) === JSON.stringify(step.equals);
  if (step.contains !== undefined) return String(value).includes(step.contains);
  return Boolean(value) === (step.truthy ?? true);
}

function describeDownloadExpect(
  step: Extract<Step, { type: "download" }>,
): string {
  const parts: string[] = [`点击 ${step.click}`];
  if (step.namePrefix !== undefined) parts.push(`前缀=${step.namePrefix}`);
  if (step.nameSuffix !== undefined) parts.push(`后缀=${step.nameSuffix}`);
  if (step.headerContains !== undefined)
    parts.push(`首行含=${step.headerContains}`);
  return parts.join(" ");
}

function describeDomExpectation(
  step: Extract<Step, { type: "dom_assert" }>,
): string {
  const parts = [step.selector];
  if (step.state !== undefined) parts.push(`state=${step.state}`);
  if (step.text !== undefined) parts.push(`text=${step.text}`);
  if (step.contains !== undefined) parts.push(`contains=${step.contains}`);
  if (step.value !== undefined) parts.push(`value=${step.value}`);
  if (step.count !== undefined) parts.push(`count=${step.count}`);
  if (step.countAtLeast !== undefined)
    parts.push(`countAtLeast=${step.countAtLeast}`);
  return parts.join(" ");
}

function describeApiExpectation(
  step: Extract<Step, { type: "api_assert" }>,
): string {
  const parts = [`${step.method ?? "*"} ${step.url}`];
  if (step.expectStatus !== undefined)
    parts.push(`status=${step.expectStatus}`);
  if (step.expectJson !== undefined)
    parts.push(`json=${JSON.stringify(step.expectJson)}`);
  return parts.join(" ");
}
