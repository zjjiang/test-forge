import { randomBytes } from "node:crypto";
import type { Store } from "./db.js";

export type RunStatus = "running" | "passed" | "failed" | "needs_review" | "skipped";

export interface RunRow {
  id: string;
  projectId: string;
  scenarioId: string;
  scenarioName: string;
  status: RunStatus;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** 生成 run id：YYYYMMDD-HHMMSS-xxxx（本地时区，同秒内靠 4 位随机区分） */
export function newRunId(date: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const ts =
    String(date.getFullYear()).padStart(4, "0") +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds());
  const suffix = randomBytes(2).toString("hex");
  return `${ts}-${suffix}`;
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    scenarioId: String(r.scenario_id),
    scenarioName: String(r.scenario_name),
    status: String(r.status) as RunStatus,
    triggeredBy: String(r.triggered_by ?? ""),
    startedAt: String(r.started_at),
    finishedAt: String(r.finished_at ?? ""),
    durationMs: Number(r.duration_ms ?? 0),
  };
}

export function createRun(
  store: Store,
  input: { projectId: string; scenarioId: string; scenarioName: string; triggeredBy?: string },
): RunRow {
  const row = {
    id: newRunId(),
    projectId: input.projectId,
    scenarioId: input.scenarioId,
    scenarioName: input.scenarioName,
    triggeredBy: input.triggeredBy ?? "",
  };
  store.db
    .prepare(
      "INSERT INTO runs (id, project_id, scenario_id, scenario_name, status, triggered_by, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
    )
    .run(row.id, row.projectId, row.scenarioId, row.scenarioName, row.triggeredBy, new Date().toISOString());
  return { ...row, status: "running", startedAt: new Date().toISOString(), finishedAt: "", durationMs: 0 };
}

export function finishRun(store: Store, id: string, status: Exclude<RunStatus, "running">): void {
  const ts = new Date().toISOString();
  const startedAt = String(
    (store.db.prepare("SELECT started_at FROM runs WHERE id = ?").get(id) as { started_at?: string } | undefined)?.started_at ?? ts,
  );
  const durationMs = Math.max(0, Date.parse(ts) - Date.parse(startedAt));
  store.db
    .prepare("UPDATE runs SET status=?, finished_at=?, duration_ms=? WHERE id=?")
    .run(status, ts, durationMs, id);
}

export function getRun(store: Store, id: string): RunRow | null {
  const r = store.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!r || typeof r !== "object") return null;
  return rowToRun(r as Record<string, unknown>);
}

export function listRuns(
  store: Store,
  filter: { projectId?: string; scenarioId?: string; limit?: number } = {},
): RunRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.projectId) {
    where.push("project_id = ?");
    args.push(filter.projectId);
  }
  if (filter.scenarioId) {
    where.push("scenario_id = ?");
    args.push(filter.scenarioId);
  }
  const sql =
    "SELECT * FROM runs " +
    (where.length ? "WHERE " + where.join(" AND ") : "") +
    " ORDER BY started_at DESC LIMIT ?";
  args.push(String(filter.limit ?? 50));
  const rows = store.db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map(rowToRun);
}
