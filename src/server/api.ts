import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { openStore, DEFAULT_DB_PATH } from '../store/db.js';
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	updateProject,
	ProjectInputError,
} from '../store/projects.js';
import { deleteVar, listVars, setVar, VarInputError } from '../store/vars.js';
import { listRuns, getRun } from '../store/runs.js';
import { loadScenarioFile } from '../scenario/loader.js';
import { runScenario, type SkipInfo } from '../runner/runner.js';
import type { RunResult } from '../runner/types.js';

export interface ApiOptions {
	dbPath?: string;
	/** 场景 YAML 根目录：<root>/<projectId>/*.yaml */
	scenariosDir?: string;
	dataDir?: string;
}

interface PendingRun {
	promise: Promise<RunResult | SkipInfo>;
}

const ok = <T>(data: T, meta: Record<string, unknown> = {}): { success: true; data: T; error: null; meta: Record<string, unknown> } => ({
	success: true,
	data,
	error: null,
	meta,
});
const fail = (error: string, code = 400): { success: false; data: null; error: string; code: number } => ({
	success: false,
	data: null,
	error,
	code,
});

export function buildApp(opts: ApiOptions = {}): FastifyInstance {
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  const dataDir = opts.dataDir ?? path.dirname(dbPath);
  const scenariosDir = opts.scenariosDir ?? path.resolve("scenarios");
  const store = openStore(dbPath);
  const pending = new Map<string, PendingRun>();

  const app = Fastify({ bodyLimit: 1 * 1024 * 1024 });
  app.register(fastifyStatic, { root: path.resolve("public"), prefix: "/" });

  app.addHook("onClose", async () => {
    store.close();
  });

  const envelope = (handler: () => unknown): unknown => {
    try {
      return ok(handler());
    } catch (e) {
      if (e instanceof ProjectInputError || e instanceof VarInputError) return fail(e.message, 400);
      return fail(e instanceof Error ? e.message : String(e), 500);
    }
  };

  // ---- projects ----
  app.get("/api/projects", async () => envelope(() => listProjects(store)));

  app.post("/api/projects", async (req) => {
    const b = req.body as Record<string, unknown>;
    return envelope(() => {
      const p = createProject(store, {
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        description: b.description === undefined ? undefined : String(b.description),
        baseUrl: String(b.baseUrl ?? ""),
        blockedRoutes: Array.isArray(b.blockedRoutes) ? (b.blockedRoutes as string[]) : undefined,
        dataPrefix: b.dataPrefix === undefined ? undefined : String(b.dataPrefix),
      });
      return p;
    });
  });

  app.get("/api/projects/:id", async (req, rep) => {
    const p = getProject(store, (req.params as { id: string }).id);
    if (p === null) {
      return rep.code(404).send(fail("project not found", 404));
    }
    return ok(p);
  });

  app.put("/api/projects/:id/guards", async (req, rep) => {
    const id = (req.params as { id: string }).id;
    const b = req.body as { blockedRoutes?: string[]; dataPrefix?: string };
    return envelope(() => {
      if (getProject(store, id) === null) throw new ProjectInputError("project not found");
      return updateProject(store, id, {
        blockedRoutes: b.blockedRoutes,
        dataPrefix: b.dataPrefix,
      });
    });
  });

  app.delete("/api/projects/:id", async (req) => {
    return envelope(() => ({ deleted: deleteProject(store, (req.params as { id: string }).id) }));
  });

  // ---- vars ----
  app.get("/api/projects/:id/vars", async (req) =>
    envelope(() => listVars(store, (req.params as { id: string }).id)),
  );

  app.put("/api/projects/:id/vars/:key", async (req, rep) => {
    const { id, key } = req.params as { id: string; key: string };
    const b = req.body as { value?: string; isSecret?: boolean; note?: string };
    if (typeof b.value !== "string") return rep.code(400).send(fail("value is required", 400));
    return envelope(() => {
      setVar(store, id, { key, value: b.value ?? "", isSecret: b.isSecret === true, note: b.note ?? "" });
      return { key };
    });
  });

  app.delete("/api/projects/:id/vars/:key", async (req) => {
    const { id, key } = req.params as { id: string; key: string };
    return envelope(() => ({ deleted: deleteVar(store, id, key) }));
  });

  // ---- scenarios (file index over scenarios/<projectId>/) ----
  app.get("/api/projects/:id/scenarios", async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = path.join(scenariosDir, id);
    if (!fs.existsSync(dir)) return ok([], { total: 0 });
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();
    const items = [];
    for (const f of files) {
      const loaded = await loadScenarioFile(path.join(dir, f));
      if (loaded.result.ok) {
        const s = loaded.result.scenario;
        const lastRun = listRuns(store, { projectId: id, scenarioId: s.name, limit: 1 })[0];
        items.push({
          file: f,
          name: s.name,
          actors: Object.keys(s.actors),
          steps: s.steps.length,
          requires: s.requires?.env ?? [],
          valid: true,
          issues: [],
          lastRun: lastRun ?? null,
        });
      } else {
        items.push({ file: f, name: f, actors: [], steps: 0, requires: [], valid: false, issues: loaded.result.issues, lastRun: null });
      }
    }
    return ok(items, { total: items.length });
  });

  // ---- runs ----
  app.get("/api/runs", async (req) => {
    const q = req.query as { limit?: string };
    return ok(listRuns(store, { limit: Number(q.limit ?? 20) }));
  });

  app.get("/api/projects/:id/runs", async (req) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { scenario?: string; limit?: string };
    return envelope(() => listRuns(store, { projectId: id, scenarioId: q.scenario, limit: Number(q.limit ?? 50) }));
  });

  app.post("/api/projects/:id/runs", async (req, rep) => {
    const id = (req.params as { id: string }).id;
    const b = req.body as { file?: string; triggeredBy?: string };
    const project = getProject(store, id);
    if (project === null) return rep.code(404).send(fail("project not found", 404));
    const file = b.file ?? "";
    if (file.includes("..") || file.includes("/")) return rep.code(400).send(fail("file must be a bare file name", 400));
    const filePath = path.join(scenariosDir, id, file);
    const loaded = await loadScenarioFile(filePath);
    if (!loaded.result.ok) return rep.code(400).send({ ...fail(loaded.result.issues.join("; "), 400) });
    const scenario = loaded.result.scenario;
    const resolved = scenario.baseUrl !== undefined ? scenario : { ...scenario, baseUrl: project.baseUrl };
    let runId = "";
    void runScenario({
      store,
      dataDir,
      scenario: resolved,
      scenarioPath: filePath,
      projectId: id,
      triggeredBy: b.triggeredBy ?? "web",
      onStart: (started) => {
        runId = started;
      },
    })
      .then((r) => {
        pending.delete("runId" in r ? r.runId : r.run.id);
      })
      .catch((e: unknown) => {
        pending.delete(runId);
        app.log.error(`run ${runId} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    // runScenario 的 run 记录在首个 await 前落库，微任务里 runId 一定已就绪
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (runId !== "") resolve();
        else setImmediate(check);
      };
      check();
    });
    return rep.code(202).send(ok({ runId }));
  });

  app.get("/api/projects/:id/runs/:runId", async (req, rep) => {
    const { id, runId } = req.params as { id: string; runId: string };
    const run = getRun(store, runId);
    if (run === null || run.projectId !== id) return rep.code(404).send(fail("run not found", 404));
    const runDir = path.join(dataDir, "projects", id, "runs", runId);
    let summary: unknown = null;
    try {
      summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
    } catch {
      summary = null;
    }
    return ok({ run, summary });
  });

  // evidence files (screenshots / trace / report.html) with traversal guard
  const MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".zip": "application/zip",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".log": "text/plain; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
  };
  app.get("/api/projects/:id/runs/:runId/files/*", async (req, rep) => {
    const { id, runId } = req.params as { id: string; runId: string };
    const rel = (req.params as { "*": string })["*"];
    if (rel.includes("..")) return rep.code(400).send(fail("bad path", 400));
    const filePath = path.join(dataDir, "projects", id, "runs", runId, rel);
    if (!filePath.startsWith(path.join(dataDir, "projects", id, "runs", runId))) {
      return rep.code(400).send(fail("bad path", 400));
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return rep.code(404).send(fail("file not found", 404));
    }
    const ext = path.extname(filePath).toLowerCase();
    return rep.type(MIME[ext] ?? "application/octet-stream").send(fs.createReadStream(filePath));
  });

  return app;
}
