import { decryptSecret, encryptSecret, getSecretKey, SECRET_MASK } from "./crypto.js";
import type { Store } from "./db.js";

export interface VarInput {
  key: string;
  value: string;
  isSecret: boolean;
  note?: string;
}

export interface VarView {
  key: string;
  value: string;
  isSecret: boolean;
  note: string;
  updatedAt: string;
}

export interface VarSnapshot {
  values: Readonly<Record<string, string>>;
  redacted: Readonly<Record<string, string>>;
}

export class VarInputError extends Error {}

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

function decode(r: Record<string, unknown>): { plain: string; isSecret: boolean } {
  const isSecret = Number(r.is_secret) === 1;
  const raw = r.value instanceof Buffer ? r.value : Buffer.from(String(r.value));
  const plain = isSecret ? decryptSecret(raw, getSecretKey()) : raw.toString("utf8");
  return { plain, isSecret };
}

export function setVar(store: Store, projectId: string, input: VarInput): void {
  if (!KEY_RE.test(input.key)) throw new VarInputError("var key must match ^[A-Z][A-Z0-9_]*$");
  const enc = input.isSecret ? encryptSecret(input.value, getSecretKey()) : Buffer.from(input.value, "utf8");
  const ts = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO vars (project_id, key, value, is_secret, note, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(project_id, key) DO UPDATE SET value=excluded.value, is_secret=excluded.is_secret, note=excluded.note, updated_at=excluded.updated_at",
    )
    .run(projectId, input.key, enc, input.isSecret ? 1 : 0, input.note ?? "", ts);
}

export function deleteVar(store: Store, projectId: string, key: string): boolean {
  return store.db.prepare("DELETE FROM vars WHERE project_id = ? AND key = ?").run(projectId, key).changes > 0;
}

export function listVars(store: Store, projectId: string): VarView[] {
  const rows = store.db
    .prepare("SELECT key, value, is_secret, note, updated_at FROM vars WHERE project_id = ? ORDER BY key")
    .all(projectId) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: String(r.key),
    value: Number(r.is_secret) === 1 ? SECRET_MASK : decode(r).plain,
    isSecret: Number(r.is_secret) === 1,
    note: String(r.note ?? ""),
    updatedAt: String(r.updated_at),
  }));
}

export function varSnapshot(store: Store, projectId: string): VarSnapshot {
  const rows = store.db.prepare("SELECT key, value, is_secret FROM vars WHERE project_id = ?").all(projectId) as Record<string, unknown>[];
  const values: Record<string, string> = {};
  const redacted: Record<string, string> = {};
  for (const r of rows) {
    const { plain, isSecret } = decode(r);
    const k = String(r.key);
    values[k] = plain;
    redacted[k] = isSecret ? SECRET_MASK : plain;
  }
  return { values, redacted };
}
