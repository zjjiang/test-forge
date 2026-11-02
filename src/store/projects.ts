import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

export interface ProjectInput {
  id: string;
  name: string;
  description?: string;
  baseUrl: string;
  blockedRoutes?: string[];
  dataPrefix?: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  blockedRoutes: string[];
  dataPrefix: string;
  createdAt: string;
  updatedAt: string;
}

export class ProjectInputError extends Error {}

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function assertUrl(u: string): void {
  try {
    if (!new URL(u)) throw new Error("empty");
  } catch {
    throw new ProjectInputError("baseUrl must be a valid URL");
  }
}

function now(): string {
  return new Date().toISOString();
}

function rowToProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ""),
    baseUrl: String(r.base_url),
    blockedRoutes: JSON.parse(String(r.blocked_routes ?? "[]")) as string[],
    dataPrefix: String(r.data_prefix ?? ""),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function createProject(store: Store, input: ProjectInput): ProjectRow {
  if (!ID_RE.test(input.id)) throw new ProjectInputError(`project id must match ${ID_RE.source}`);
  if (!input.name.trim()) throw new ProjectInputError("project name required");
  assertUrl(input.baseUrl);
  const ts = now();
  const routes = input.blockedRoutes ?? [];
  store.db
    .prepare(
      "INSERT INTO projects (id, name, description, base_url, blocked_routes, data_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(input.id, input.name.trim(), (input.description ?? "").trim(), input.baseUrl, JSON.stringify(routes), input.dataPrefix ?? "", ts, ts);
  return {
    id: input.id,
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    baseUrl: input.baseUrl,
    blockedRoutes: routes,
    dataPrefix: input.dataPrefix ?? "",
    createdAt: ts,
    updatedAt: ts,
  };
}

export function getProject(store: Store, id: string): ProjectRow | null {
  const r = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!r || typeof r !== "object") return null;
  return rowToProject(r as Record<string, unknown>);
}

export function listProjects(store: Store): ProjectRow[] {
  const rows = store.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map(rowToProject);
}

export function deleteProject(store: Store, id: string): boolean {
  return store.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
}

export function updateProject(
  store: Store,
  id: string,
  patch: Partial<Pick<ProjectInput, "name" | "description" | "baseUrl" | "blockedRoutes" | "dataPrefix">>,
): ProjectRow {
  const cur = getProject(store, id);
  if (!cur) throw new ProjectInputError(`project not found: ${id}`);
  const next = { ...cur, ...patch };
  if (patch.baseUrl !== undefined) assertUrl(patch.baseUrl);
  const ts = now();
  store.db
    .prepare("UPDATE projects SET name=?, description=?, base_url=?, blocked_routes=?, data_prefix=?, updated_at=? WHERE id=?")
    .run(next.name, next.description, next.baseUrl, JSON.stringify(next.blockedRoutes), next.dataPrefix, ts, id);
  return { ...next, createdAt: cur.createdAt, updatedAt: ts };
}
