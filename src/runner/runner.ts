import { cpSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { Store } from "../store/db.js";
import { createRun, finishRun, type RunRow } from "../store/runs.js";
import { varSnapshot } from "../store/vars.js";
import type { Scenario, Step } from "../scenario/schema.js";
import { interpolateDeep } from "../scenario/interpolate.js";
import { openActor, type ActorRuntime } from "./env.js";
import { executeStep, freezeAndShot, type AIDriver } from "./actions.js";
import { makeRedactor } from "./redact.js";
import { Evidence } from "./evidence.js";
import { renderReport } from "../evidence/report.js";
import { verdict } from "./verdict.js";
import { midsceneConfigured, createMidsceneDriver } from "./midscene.js";
import { resolveAiEnv } from "../ai/glm.js";
import type { RunResult, StepResult, StepStatus } from "./types.js";

export interface RunOptions {
  store: Store;
  dataDir: string;
  scenario: Scenario;
  /** 场景文件路径，原样拷贝进证据目录做快照 */
  scenarioPath?: string;
  projectId: string;
  triggeredBy?: string;
  /** CLI --var 覆盖，优先级最高 */
  varsOverride?: Record<string, string>;
  headless?: boolean;
  /** run 记录落库后立刻回调（浏览器还没启动），供 API 即时返回 runId */
  onStart?: (runId: string) => void;
}

export interface SkipInfo {
  status: "skipped";
  reason: string;
  run: RunRow;
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 600_000;

/** 场景级 skip：requires.env 缺失时不启动浏览器。 */
export function missingEnv(
  scenario: Scenario,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (scenario.requires?.env ?? []).filter(
    (name) => env[name] === undefined || env[name] === "",
  );
}

export async function runScenario(
  opts: RunOptions,
): Promise<RunResult | SkipInfo> {
  const { store, scenario } = opts;
  /* requires.env 检查进程环境 + 项目变量（secret 存 DB，也应计入） */
  const snapEarly = varSnapshot(store, opts.projectId);
  const missing = missingEnv(scenario, { ...process.env, ...snapEarly.values });
  const run = createRun(store, {
    projectId: opts.projectId,
    scenarioId: scenario.name,
    scenarioName: scenario.name,
    triggeredBy: opts.triggeredBy,
  });
  opts.onStart?.(run.id);
  const evidence = new Evidence(opts.dataDir, run.id, opts.projectId);
  if (opts.scenarioPath !== undefined) {
    try {
      cpSync(opts.scenarioPath, path.join(evidence.dir, "scenario.yaml"));
    } catch {
      evidence.log("WARN 快照场景文件失败");
    }
  }
  if (scenario.baseUrl === undefined) {
    const reason = "场景没有 baseUrl，项目也没有配置 baseUrl";
    finishRun(store, run.id, "failed");
    evidence.log("FAIL " + reason);
    return {
      runId: run.id,
      projectId: opts.projectId,
      scenarioName: scenario.name,
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      steps: [],
      warnings: [{ where: "baseUrl", message: reason }],
      dir: evidence.dir,
    };
  }
  if (missing.length > 0) {
    const reason = "缺少环境变量: " + missing.join(", ");
    evidence.log("SKIP " + reason);
    finishRun(store, run.id, "skipped");
    return { status: "skipped", reason, run };
  }

  const snap = snapEarly;
  const now = new Date();
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const mmdd = pad2(now.getMonth() + 1) + pad2(now.getDate());
  const hms =
    pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  const builtins: Record<string, string> = {
    RUN_DATE: `${now.getFullYear()}${mmdd}`,
    RUN_TIME: hms,
    RUN_STAMP: `${mmdd}-${hms}`,
    RUN_STAMP_COMPACT: mmdd + hms,
  };
  // 场景变量可以引用内置变量/项目变量（如 shopName: "E2E-x-${var:RUN_STAMP}"），
  // 反复解析直到不再变化（最多 5 轮，防环）
  let declared: Record<string, unknown> = {
    ...(opts.scenario.variables ?? {}),
  };
  for (let round = 0; round < 5; round += 1) {
    const next = interpolateDeep(declared, {
      ...builtins,
      ...snap.values,
      ...declared,
      ...(opts.varsOverride ?? {}),
    });
    if (JSON.stringify(next) === JSON.stringify(declared)) break;
    declared = next as Record<string, unknown>;
  }
  const vars: Record<string, unknown> = {
    ...builtins,
    ...snap.values,
    ...declared,
    ...(opts.varsOverride ?? {}),
  };
  for (const [k, v] of Object.entries(snap.values)) {
    if (vars[k] === undefined) vars[k] = v;
  }
  const redactor = makeRedactor({
    ...snap.redacted,
    ...(opts.varsOverride ?? {}),
  });
  // extract 步骤写入的 run 内变量，每步执行时合并插值
  let runtimeVars: Record<string, string> = {};
  const stepVars = (): Record<string, unknown> => ({ ...vars, ...runtimeVars });
  // actors/guards 先插值；steps 留到逐条执行时插（extract 的变量运行中才存在）
  const resolvedActors = interpolateDeep(scenario.actors, vars);
  const baseUrl: string = scenario.baseUrl ?? "";
  evidence.writeJson("vars.json", {
    redacted: snap.redacted,
    overrides: opts.varsOverride ?? {},
  });
  const log = (line: string): void => evidence.log(redactor(line));
  log(
    `RUN ${run.id} scenario="${scenario.name}" project=${opts.projectId} actors=${Object.keys(scenario.actors).join(",")}`,
  );

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const actorNames = Object.keys(scenario.actors);
  const runtimes = new Map<string, ActorRuntime>();
  let ai: AIDriver | null = null;
  const aiEnv = resolveAiEnv(store, snap.values);
  if (midsceneConfigured(aiEnv)) {
    ai = await createMidsceneDriver(aiEnv);
    log("AI Midscene driver ready");
  } else {
    log(
      "AI Midscene 未配置：在首页「AI 配置」里填模型名 / Base URL / API Key 后可用",
    );
  }
  const stepTimeoutMs = scenario.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const stepResults: StepResult[] = [];
  let mainCount = 0;
  const warnings: { where: string; message: string }[] = [];
  try {
    for (const name of actorNames) {
      const rt = await openActor({
        browser,
        name,
        actor: resolvedActors[name] ?? {},
        baseUrl: baseUrl,
        blockedRoutes: scenario.guards?.blockedRoutes ?? [],
        log,
      });
      if (scenario.trace !== false) {
        await rt.context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false,
        });
      }
      runtimes.set(name, rt);
    }

    const runStep = async (
      step: Step,
      i: number,
      teardown: boolean,
    ): Promise<void> => {
      const actorName = step.as ?? actorNames[0] ?? "";
      const runtime = runtimes.get(actorName);
      if (runtime === undefined) {
        stepResults.push(
          emptyStep(i, step, actorName, "skipped", `actor ${actorName} 未打开`),
        );
        return;
      }
      const stepShots: string[] = [];
      let inst: Step;
      try {
        /* flow 的子步骤顶层不插值：extract 写入的运行时变量此刻还不存在，
           子步骤在 flow 执行时逐个用 stepVars() 重新插值 */
        inst =
          step.type === "flow"
            ? ({
                ...(interpolateDeep(
                  { ...step, steps: [] },
                  stepVars(),
                ) as Step),
                steps: step.steps,
              } as Step)
            : (interpolateDeep(step, stepVars()) as Step);
      } catch (e) {
        // 变量缺失等插值失败按普通失败步骤处理，不中断整个 run
        stepResults.push(
          emptyStep(
            i,
            step,
            actorName,
            step.onFail === "warn" ? "warned" : "failed",
            e instanceof Error ? e.message : String(e),
          ),
        );
        if (step.onFail === "warn")
          warnings.push({
            where: `step ${i + 1} (${step.id ?? step.type})`,
            message: e instanceof Error ? e.message : String(e),
          });
        return;
      }
      const result = await executeStep(inst, {
        runtime,
        baseUrl: baseUrl,
        stepTimeoutMs,
        ai,
        log,
        shot: async (label, phase, rt) => {
          const p = evidence.shotPath(label, phase);
          await freezeAndShot((rt ?? runtime).page, p);
          stepShots.push(path.relative(evidence.dir, p));
        },
        runtimeFor: (as) => runtimes.get(as ?? actorNames[0] ?? "") ?? runtime,
        setVar: (name, value) => {
          runtimeVars = { ...runtimeVars, [name]: value };
        },
        downloadPath: (suggested) => evidence.filePath("downloads", suggested),
        stepVars: stepVars,
      });
      const status: StepStatus =
        result.skipped === true
          ? "skipped"
          : result.ok
            ? "passed"
            : step.onFail === "warn"
              ? "warned"
              : "failed";
      stepResults.push({
        index: i,
        stepId: step.id ?? `${step.type}-${i + 1}`,
        type: step.type,
        actor: actorName,
        expect: step.expect ?? "",
        status,
        ms: result.attempts.reduce((s, a) => s + a.ms, 0),
        attempts: result.attempts,
        assertions: result.assertions,
        error: result.ok ? "" : result.error,
        shots: stepShots,
        ...(result.subSteps !== undefined ? { subSteps: result.subSteps } : {}),
      });
      if (result.subSteps !== undefined) {
        for (const sub of result.subSteps) {
          if (sub.status === "warned") {
            warnings.push({
              where: `step ${i + 1} (${step.id ?? step.type}) › ${sub.stepId}`,
              message: sub.error || "子步骤未通过",
            });
          }
        }
      }
      if (!result.ok && step.onFail === "warn")
        warnings.push({
          where: `step ${i + 1} (${step.id ?? step.type})`,
          message: result.error,
        });
    };
    mainCount = scenario.steps.length;
    for (const [i, step] of scenario.steps.entries())
      await runStep(step, i, false);
    if (scenario.teardown !== undefined) {
      log("TEARDOWN begin");
      for (const [i, step] of scenario.teardown.entries()) {
        await runStep(step, scenario.steps.length + i, true);
      }
    }
  } finally {
    for (const [name, rt] of runtimes) {
      try {
        if (scenario.trace !== false) {
          await rt.context.tracing.stop({
            path: path.join(evidence.dir, `trace-${name}.zip`),
          });
        }
        await rt.context.close();
      } catch (e) {
        log(
          `WARN 收尾 ${name} 失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await browser.close().catch(() => undefined);
  }

  const status = verdict(stepResults.slice(0, mainCount));
  for (const t of stepResults.slice(mainCount)) {
    if (t.status === "failed" || t.status === "warned") {
      warnings.push({
        where: `teardown ${t.stepId}`,
        message: t.error || "teardown 步骤未通过",
      });
    }
  }
  const finishedAt = new Date().toISOString();
  const result: RunResult = {
    runId: run.id,
    projectId: opts.projectId,
    scenarioName: scenario.name,
    status,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    steps: stepResults,
    warnings,
    dir: evidence.dir,
  };
  evidence.writeSummary(result);
  evidence.writeText(
    "report.html",
    renderReport(
      result,
      warnings.map((w) => w.where + ": " + w.message),
    ),
  );
  evidence.writeJson(
    "assertions.json",
    stepResults.flatMap((s) => s.assertions),
  );
  log(`DONE status=${status} steps=${stepResults.length}`);
  finishRun(
    store,
    run.id,
    status === "skipped"
      ? "skipped"
      : status === "passed"
        ? "passed"
        : status === "failed"
          ? "failed"
          : "needs_review",
  );
  return result;
}

function emptyStep(
  i: number,
  step: Step,
  actor: string,
  status: StepStatus,
  error: string,
): StepResult {
  return {
    index: i,
    stepId: step.id ?? `${step.type}-${i + 1}`,
    type: step.type,
    actor,
    expect: step.expect ?? "",
    status,
    ms: 0,
    attempts: [],
    assertions: [],
    error,
    shots: [],
  };
}
