export type StepStatus = "passed" | "failed" | "warned" | "skipped";
export type AssertKind = "det" | "ai";

export interface AttemptRecord {
  n: number;
  ok: boolean;
  error: string;
  ms: number;
}

export interface AssertionRecord {
  stepId: string;
  type: string;
  kind: AssertKind;
  expectedText: string;
  actualText: string;
  ok: boolean;
  at: string;
}

export interface StepResult {
  index: number;
  stepId: string;
  type: string;
  actor: string;
  expect: string;
  status: StepStatus;
  ms: number;
  attempts: AttemptRecord[];
  assertions: AssertionRecord[];
  error: string;
  shots: string[];
  /** type=flow 时：环节内子步骤记录 */
  subSteps?: SubStepResult[];
}

/** flow 环节内子步骤的执行记录（进 summary，供报告折叠展示） */
export interface SubStepResult {
  stepId: string;
  type: string;
  status: StepStatus;
  error: string;
  ms: number;
  assertions: AssertionRecord[];
}

export type RunStatus = "passed" | "failed" | "needs_review" | "skipped";

export interface WarningRecord {
  where: string;
  message: string;
}

export interface RunResult {
  runId: string;
  projectId: string;
  scenarioName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  warnings: WarningRecord[];
  dir: string;
}
