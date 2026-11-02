import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface Store {
  readonly db: Database.Database;
  close(): void;
}

export const DEFAULT_DB_PATH = path.resolve("data/testforge.db");

const MIGRATIONS: string[][] = [
  [
    "CREATE TABLE projects (",
    "  id TEXT PRIMARY KEY,",
    "  name TEXT NOT NULL,",
    "  description TEXT NOT NULL DEFAULT '',",
    "  base_url TEXT NOT NULL,",
    "  blocked_routes TEXT NOT NULL DEFAULT '[]',",
    "  data_prefix TEXT NOT NULL DEFAULT '',",
    "  created_at TEXT NOT NULL,",
    "  updated_at TEXT NOT NULL",
    ");",
    "CREATE TABLE vars (",
    "  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,",
    "  key TEXT NOT NULL,",
    "  value BLOB NOT NULL,",
    "  is_secret INTEGER NOT NULL DEFAULT 0,",
    "  note TEXT NOT NULL DEFAULT '',",
    "  updated_at TEXT NOT NULL,",
    "  PRIMARY KEY (project_id, key)",
    ");",
    "CREATE TABLE scenario_index (",
    "  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,",
    "  scenario_id TEXT NOT NULL,",
    "  name TEXT NOT NULL,",
    "  file_path TEXT NOT NULL,",
    "  actor_count INTEGER NOT NULL DEFAULT 1,",
    "  step_count INTEGER NOT NULL DEFAULT 0,",
    "  last_valid INTEGER NOT NULL DEFAULT 1,",
    "  updated_at TEXT NOT NULL,",
    "  PRIMARY KEY (project_id, scenario_id)",
    ");",
    "CREATE TABLE runs (",
    "  id TEXT PRIMARY KEY,",
    "  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,",
    "  scenario_id TEXT NOT NULL,",
    "  scenario_name TEXT NOT NULL,",
    "  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','needs_review','skipped')),",
    "  triggered_by TEXT NOT NULL DEFAULT '',",
    "  started_at TEXT NOT NULL,",
    "  finished_at TEXT NOT NULL DEFAULT '',",
    "  duration_ms INTEGER NOT NULL DEFAULT 0",
    ");",
  ],
];

export function openStore(dbPath: string = DEFAULT_DB_PATH): Store {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const [i, statements] of MIGRATIONS.entries()) {
    const version = i + 1;
    const row = db.pragma("user_version", { simple: true }) as number;
    if (row >= version) continue;
    db.exec(statements.join("\n"));
    db.pragma(`user_version = ${version}`);
  }
  return { db, close: () => db.close() };
}
