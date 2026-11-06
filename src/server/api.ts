import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { openStore, DEFAULT_DB_PATH } from "../store/db.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  ProjectInputError,
} from "../store/projects.js";
import {
  deleteVar,
  listVars,
  setVar,
  varSnapshot,
  VarInputError,
} from "../store/vars.js";
import {
  aiSettingsEnv,
  aiSettingsView,
  setSetting,
  SettingInputError,
} from "../store/settings.js";
import { testAi } from "../ai/glm.js";
import { listRuns, getRun } from "../store/runs.js";
import { loadScenarioFile } from "../scenario/loader.js";
import { parseScenario } from "../scenario/schema.js";
import { parse as parseYaml } from "yaml";
import { writeFile, readFile } from "node:fs/promises";
import { aiConfigFrom, resolveAiEnv } from "../ai/glm.js";
import {
  generateScenarioYaml,
  optimizeScenarioDescription,
} from "../ai/scenario-gen.js";
import { runScenario, type SkipInfo } from "../runner/runner.js";
import type { RunResult } from "../runner/types.js";

export interface ApiOptions {
  dbPath?: string;
  /** 场景 YAML 根目录：<root>/<projectId>/*.yaml */
  scenariosDir?: string;
  dataDir?: string;
}

interface PendingRun {
  promise: Promise<RunResult | SkipInfo>;
}

const ok = <T>(
  data: T,
  meta: Record<string, unknown> = {},
): { success: true; data: T; error: null; meta: Record<string, unknown> } => ({
  success: true,
  data,
  error: null,
  meta,
});
const fail = (
  error: string,
  code = 400,
): { success: false; data: null; error: string; code: number } => ({
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
      if (
        e instanceof ProjectInputError ||
        e instanceof VarInputError ||
        e instanceof SettingInputError
      )
        return fail(e.message, 400);
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
        description:
          b.description === undefined ? undefined : String(b.description),
        baseUrl: String(b.baseUrl ?? ""),
        blockedRoutes: Array.isArray(b.blockedRoutes)
          ? (b.blockedRoutes as string[])
          : undefined,
        dataPrefix:
          b.dataPrefix === undefined ? undefined : String(b.dataPrefix),
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
      if (getProject(store, id) === null)
        throw new ProjectInputError("project not found");
      return updateProject(store, id, {
        blockedRoutes: b.blockedRoutes,
        dataPrefix: b.dataPrefix,
      });
    });
  });

  app.delete("/api/projects/:id", async (req) => {
    return envelope(() => ({
      deleted: deleteProject(store, (req.params as { id: string }).id),
    }));
  });

  // ---- vars ----
  app.get("/api/projects/:id/vars", async (req) =>
    envelope(() => listVars(store, (req.params as { id: string }).id)),
  );

  app.put("/api/projects/:id/vars/:key", async (req, rep) => {
    const { id, key } = req.params as { id: string; key: string };
    const b = req.body as { value?: string; isSecret?: boolean; note?: string };
    if (typeof b.value !== "string")
      return rep.code(400).send(fail("value is required", 400));
    return envelope(() => {
      setVar(store, id, {
        key,
        value: b.value ?? "",
        isSecret: b.isSecret === true,
        note: b.note ?? "",
      });
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
        const lastRun = listRuns(store, {
          projectId: id,
          scenarioId: s.name,
          limit: 1,
        })[0];
        items.push({
          file: f,
          name: s.name,
          module: s.module ?? null,
          actors: Object.keys(s.actors),
          steps: s.steps.length,
          requires: s.requires?.env ?? [],
          valid: true,
          issues: [],
          lastRun: lastRun ?? null,
        });
      } else {
        items.push({
          file: f,
          name: f,
          actors: [],
          steps: 0,
          requires: [],
          valid: false,
          issues: loaded.result.issues,
          lastRun: null,
        });
      }
    }
    return ok(items, { total: items.length });
  });

  // ---- scenario source: YAML 与业务描述(.md) 的读写 + AI 生成 ----
  const scenarioFileGuard = (f: string): boolean =>
    !f.includes("/") && !f.includes("..") && /\.(yaml|yml)$/.test(f);

  app.get("/api/projects/:id/scenarios/:file/source", async (req, rep) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!scenarioFileGuard(file))
      return rep.code(400).send(fail("file must be a bare .yaml name", 400));
    const filePath = path.join(scenariosDir, id, file);
    let yaml = "";
    try {
      yaml = await readFile(filePath, "utf8");
    } catch {
      return rep.code(404).send(fail("scenario file not found", 404));
    }
    let description = "";
    try {
      description = await readFile(filePath.replace(/\.ya?ml$/, ".md"), "utf8");
    } catch {
      /* 描述文件可缺省 */
    }
    return ok({ yaml, description });
  });

  app.put("/api/projects/:id/scenarios/:file/yaml", async (req, rep) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!scenarioFileGuard(file))
      return rep.code(400).send(fail("file must be a bare .yaml name", 400));
    const b = req.body as { content?: string };
    const content = b.content ?? "";
    let doc: unknown;
    try {
      doc = parseYaml(content);
    } catch (e) {
      return rep
        .code(400)
        .send(
          fail(
            `YAML 解析失败: ${e instanceof Error ? e.message : String(e)}`,
            400,
          ),
        );
    }
    const parsed = parseScenario(doc);
    if (!parsed.ok)
      return rep.code(400).send(fail(parsed.issues.join("\n"), 400));
    await writeFile(path.join(scenariosDir, id, file), content, "utf8");
    return ok({ saved: true });
  });

  app.put("/api/projects/:id/scenarios/:file/description", async (req, rep) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!scenarioFileGuard(file))
      return rep.code(400).send(fail("file must be a bare .yaml name", 400));
    const b = req.body as { content?: string };
    await writeFile(
      path.join(scenariosDir, id, file.replace(/\.ya?ml$/, ".md")),
      b.content ?? "",
      "utf8",
    );
    return ok({ saved: true });
  });

  app.post("/api/projects/:id/scenarios", async (req, rep) => {
    const id = (req.params as { id: string }).id;
    if (getProject(store, id) === null)
      return rep.code(404).send(fail("project not found", 404));
    const b = req.body as { name?: string; file?: string };
    const name = (b.name ?? "").trim();
    const file = (b.file ?? "").trim();
    if (name === "") return rep.code(400).send(fail("缺少场景名", 400));
    if (!scenarioFileGuard(file))
      return rep
        .code(400)
        .send(fail("file 必须是不带路径的 .yaml 文件名", 400));
    const filePath = path.join(scenariosDir, id, file);
    if (fs.existsSync(filePath))
      return rep.code(400).send(fail("同名场景文件已存在", 400));
    const skeleton = `# ${name}（新场景骨架：在描述里写清环节后用 AI 生成，或直接编辑）\nname: ${name}\ndescription: 待补充\nversion: 1\nactors:\n  user:\n    description: 默认角色\nsteps:\n  - id: 占位环节\n    type: flow\n    expect: 请通过 AI 生成或直接编辑本场景\n    steps:\n      - id: 打开首页\n        as: user\n        type: navigate\n        url: /\n`;
    const parsed = parseScenario(parseYaml(skeleton));
    if (!parsed.ok)
      return rep
        .code(500)
        .send(fail("骨架校验失败: " + parsed.issues.join("; "), 500));
    await writeFile(filePath, skeleton, "utf8");
    return rep.code(201).send(ok({ file, created: true }));
  });

  app.post(
    "/api/projects/:id/scenarios/:file/optimize-description",
    async (req, rep) => {
      const { id, file } = req.params as { id: string; file: string };
      if (!scenarioFileGuard(file))
        return rep.code(400).send(fail("file must be a bare .yaml name", 400));
      const b = req.body as { description?: string } | null;
      const description = (b?.description ?? "").trim();
      if (description === "")
        return rep.code(400).send(fail("描述为空，先写点业务内容再优化", 400));
      if (getProject(store, id) === null)
        return rep.code(404).send(fail("project not found", 404));
      const aiEnv = resolveAiEnv(store, varSnapshot(store, id).values);
      const r = await optimizeScenarioDescription(
        aiConfigFrom(aiEnv),
        description,
      );
      if (!r.ok) return rep.code(502).send(fail(r.error, 502));
      return ok({ description: r.description, ms: r.ms });
    },
  );

  app.post(
    "/api/projects/:id/scenarios/:file/ai-generate",
    async (req, rep) => {
      const { id, file } = req.params as { id: string; file: string };
      if (!scenarioFileGuard(file))
        return rep.code(400).send(fail("file must be a bare .yaml name", 400));
      const b = req.body as { description?: string } | null;
      const filePath = path.join(scenariosDir, id, file);
      let currentYaml = "";
      try {
        currentYaml = await readFile(filePath, "utf8");
      } catch {
        /* 新场景可以从零生成 */
      }
      let description = b?.description ?? "";
      if (description.trim() === "") {
        try {
          description = await readFile(
            filePath.replace(/\.ya?ml$/, ".md"),
            "utf8",
          );
        } catch {
          /* 描述可为空 */
        }
      }
      const project = getProject(store, id);
      if (project === null)
        return rep.code(404).send(fail("project not found", 404));
      const aiEnv = resolveAiEnv(store, varSnapshot(store, id).values);
      const cfg = aiConfigFrom(aiEnv);
      const r = await generateScenarioYaml(cfg, description, currentYaml);
      if (!r.ok) return rep.code(502).send(fail(r.error, 502));
      return ok({ yaml: r.yaml, ms: r.ms });
    },
  );

  // ---- global AI (Midscene/GLM) settings ----
  app.get("/api/ai", async () => ok(aiSettingsView(store)));

  app.put("/api/ai", async (req) => {
    const b = req.body as Record<string, unknown>;
    return envelope(() => {
      const s = (k: string): string => String(b[k] ?? "").trim();
      if (b.family !== undefined)
        setSetting(store, "MIDSCENE_MODEL_FAMILY", s("family") || "anthropic");
      if (b.model !== undefined)
        setSetting(store, "MIDSCENE_MODEL_NAME", s("model"));
      if (b.baseUrl !== undefined)
        setSetting(store, "MIDSCENE_MODEL_BASE_URL", s("baseUrl"));
      if (b.apiKey !== undefined && s("apiKey") !== "")
        setSetting(store, "MIDSCENE_MODEL_API_KEY", s("apiKey"));
      return aiSettingsView(store);
    });
  });

  /** 用当前生效配置（全局 + 环境变量兜底）发一次真实请求验证连通。 */
  app.post("/api/ai/test", async () => {
    const env = { ...aiSettingsEnv(store) };
    const cfg = aiConfigFrom(env);
    const r = await testAi(cfg);
    return ok(r);
  });

  // ---- runs ----
  app.get("/api/runs", async (req) => {
    const q = req.query as { limit?: string };
    return ok(listRuns(store, { limit: Number(q.limit ?? 20) }));
  });

  app.get("/api/projects/:id/runs", async (req) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { scenario?: string; limit?: string };
    return envelope(() =>
      listRuns(store, {
        projectId: id,
        scenarioId: q.scenario,
        limit: Number(q.limit ?? 50),
      }),
    );
  });

  app.post("/api/projects/:id/runs", async (req, rep) => {
    const id = (req.params as { id: string }).id;
    const b = req.body as { file?: string; triggeredBy?: string };
    const project = getProject(store, id);
    if (project === null)
      return rep.code(404).send(fail("project not found", 404));
    const file = b.file ?? "";
    if (file.includes("..") || file.includes("/"))
      return rep.code(400).send(fail("file must be a bare file name", 400));
    const filePath = path.join(scenariosDir, id, file);
    const loaded = await loadScenarioFile(filePath);
    if (!loaded.result.ok)
      return rep
        .code(400)
        .send({ ...fail(loaded.result.issues.join("; "), 400) });
    const scenario = loaded.result.scenario;
    const resolved =
      scenario.baseUrl !== undefined
        ? scenario
        : { ...scenario, baseUrl: project.baseUrl };
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
        app.log.error(
          `run ${runId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
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
    if (run === null || run.projectId !== id)
      return rep.code(404).send(fail("run not found", 404));
    const runDir = path.join(dataDir, "projects", id, "runs", runId);
    let summary: unknown = null;
    try {
      summary = JSON.parse(
        fs.readFileSync(path.join(runDir, "summary.json"), "utf8"),
      );
    } catch {
      summary = null;
    }
    /** 产物文件清单（download 步骤落盘），报告页下载链接用 */
    let downloads: string[] = [];
    try {
      downloads = fs
        .readdirSync(path.join(runDir, "downloads"))
        .filter((f) => fs.statSync(path.join(runDir, "downloads", f)).isFile())
        .sort();
    } catch {
      /* 无 download 步骤时目录不存在 */
    }
    return ok({ run, summary, downloads });
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
    if (
      !filePath.startsWith(path.join(dataDir, "projects", id, "runs", runId))
    ) {
      return rep.code(400).send(fail("bad path", 400));
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return rep.code(404).send(fail("file not found", 404));
    }
    const ext = path.extname(filePath).toLowerCase();
    return rep
      .type(MIME[ext] ?? "application/octet-stream")
      .send(fs.createReadStream(filePath));
  });

  return app;
}
