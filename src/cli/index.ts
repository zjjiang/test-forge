import { Command, InvalidArgumentError } from "commander";
import { loadScenarios } from "../scenario/loader.js";
import { errOut, out } from "./io.js";
import { openStore, DEFAULT_DB_PATH } from "../store/db.js";
import { getProject, createProject, listProjects } from "../store/projects.js";
import { setVar, listVars } from "../store/vars.js";
import { runScenario } from "../runner/runner.js";
import { listRuns, getRun } from "../store/runs.js";
import type { RunResult } from "../runner/types.js";
import path from "node:path";

const DEFAULT_DATA_DIR = path.dirname(DEFAULT_DB_PATH);

interface RunOpts {
  project: string;
  var?: Record<string, string>;
  env?: Record<string, string>;
  triggeredBy: string;
  headed?: boolean;
  json?: boolean;
}

function collectPairs(
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) {
    throw new InvalidArgumentError(`需要 k=v 形式，收到「${value}」`);
  }
  const name = value
    .slice(0, eq)
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase();
  return { ...previous, [name]: value.slice(eq + 1) };
}

function summaryOf(r: RunResult): Record<string, unknown> {
  return {
    runId: r.runId,
    status: r.status,
    durationMs: r.durationMs,
    dir: r.dir,
    steps: r.steps.length,
    warnings: r.warnings.length,
  };
}

const program = new Command();

program
  .name("test-forge")
  .description("场景驱动的 AI 原生测试平台")
  .version("0.1.0");

program
  .command("validate")
  .description("校验场景 YAML（文件或目录）")
  .argument("<targets...>", "场景文件或目录，可多个")
  .option("--json", "输出机器可读的 JSON 结果")
  .action(async (targets: string[], opts: { json?: boolean }) => {
    const files: {
      sourcePath: string;
      result: import("../scenario/schema.js").ParseResult;
    }[] = [];
    for (const t of targets) {
      try {
        files.push(...(await loadScenarios(t)));
      } catch (e) {
        files.push({
          sourcePath: t,
          result: {
            ok: false,
            issues: [
              `无法读取路径: ${e instanceof Error ? e.message : String(e)}`,
            ],
          },
        });
      }
    }
    if (opts.json) {
      out(
        JSON.stringify(
          {
            success: files.every((f) => f.result.ok),
            data: files.map((f) => ({
              file: f.sourcePath,
              valid: f.result.ok,
              errors: f.result.ok ? [] : f.result.issues,
            })),
            error: null,
            meta: {
              total: files.length,
              valid: files.filter((f) => f.result.ok).length,
            },
          },
          null,
          2,
        ),
      );
      if (!files.length) errOut("警告：目标路径里没有找到任何场景文件");
      process.exitCode =
        files.some((f) => !f.result.ok) || !files.length ? 1 : 0;
      return;
    }
    if (!files.length) {
      errOut("目标路径里没有找到任何场景文件（只扫描 .yaml/.yml）");
      process.exitCode = 1;
      return;
    }
    for (const f of files) {
      if (f.result.ok) {
        out(`✓ ${f.sourcePath}`);
      } else {
        out(`✗ ${f.sourcePath}`);
        for (const issue of f.result.issues) out(`    ${issue}`);
      }
    }
    const valid = files.filter((f) => f.result.ok).length;
    out(`\n${valid}/${files.length} 个场景通过校验`);
    process.exitCode = valid === files.length ? 0 : 1;
  });

program
  .command("run")
  .description("执行场景（文件或目录）")
  .argument("<target>", "场景文件或目录")
  .requiredOption(
    "-p, --project <id>",
    "项目 ID（决定 baseUrl 变量与证据目录）",
  )
  .option("--var <k=v>", "变量覆盖，可多次", collectPairs)
  .option(
    "--env <n=v>",
    "注入环境变量（如 MIDSCENE_MODEL_API_KEY），可多次",
    collectPairs,
  )
  .option("--triggered-by <who>", "触发人（人 / Agent / CI）", "")
  .option("--headed", "有头浏览器（调试用）")
  .option("--json", "输出机器可读的 JSON 结果")
  .action(async (target: string, opts: RunOpts) => {
    const store = openStore();
    try {
      const project = getProject(store, opts.project);
      if (project === null) {
        errOut(
          `项目「${opts.project}」不存在，先用 var/project 命令或 Web UI 创建`,
        );
        process.exitCode = 2;
        return;
      }
      const loaded = await loadScenarios(target);
      if (loaded.length === 0) {
        errOut("没有找到场景文件（只扫描 .yaml/.yml）");
        process.exitCode = 2;
        return;
      }
      const results: unknown[] = [];
      for (const f of loaded) {
        if (!f.result.ok) {
          errOut(`✗ ${f.sourcePath}`);
          for (const issue of f.result.issues) errOut(`    ${issue}`);
          process.exitCode = 1;
          continue;
        }
        for (const [n, v] of Object.entries(opts.env ?? {})) process.env[n] = v;
        const r = await runScenario({
          store,
          dataDir: path.dirname(DEFAULT_DB_PATH),
          scenario: { ...f.result.scenario, baseUrl: project.baseUrl },
          scenarioPath: f.sourcePath,
          projectId: project.id,
          triggeredBy: opts.triggeredBy || "cli",
          varsOverride: opts.var,
          headless: !opts.headed,
        });
        if ("reason" in r) {
          out(`SKIP ${f.sourcePath} — ${r.reason} (run ${r.run.id})`);
          results.push({
            file: f.sourcePath,
            status: "skipped",
            reason: r.reason,
            runId: r.run.id,
          });
          continue;
        }
        results.push({ file: f.sourcePath, ...summaryOf(r) });
        out(
          `${r.status === "passed" ? "✓" : "✗"} ${f.sourcePath} → ${r.status} (run ${r.runId}, ${r.durationMs}ms)`,
        );
        out(`    证据目录: ${r.dir}`);
        if (r.status !== "passed") process.exitCode = 4;
      }
      if (opts.json) {
        out(
          JSON.stringify(
            {
              success: process.exitCode === undefined || process.exitCode === 0,
              data: results,
              error: null,
              meta: { total: results.length },
            },
            null,
            2,
          ),
        );
      }
    } finally {
      store.close();
    }
  });

program
  .command("serve")
  .description("启动 Web 控制台")
  .option("--port <n>", "端口", "3300")
  .option("--host <h>", "监听地址", "127.0.0.1")
  .action(async (opts: { port: string; host: string }) => {
    process.env.TESTFORGE_PORT = opts.port;
    process.env.TESTFORGE_HOST = opts.host;
    await import("../server/index.js");
  });

program
  .command("runs")
  .description("查看执行历史")
  .option("-p, --project <id>", "按项目过滤")
  .option("-s, --scenario <name>", "按场景过滤")
  .option("-n, --limit <n>", "条数", "20")
  .option("--json", "JSON 输出")
  .action(async (opts: { project?: string; scenario?: string; limit: string; json?: boolean }) => {
    const store = openStore();
    try {
      const rows = listRuns(store, {
        projectId: opts.project,
        scenarioId: opts.scenario,
        limit: Number(opts.limit),
      });
      if (opts.json) {
        out(JSON.stringify({ success: true, data: rows, error: null, meta: { total: rows.length } }, null, 2));
        return;
      }
      if (rows.length === 0) {
        out("（还没有执行记录）");
        return;
      }
      for (const r of rows) {
        out(`${r.id}\t${r.projectId}\t${r.scenarioName}\t${r.status}\t${r.durationMs}ms\t${r.triggeredBy || "-"}\t${r.startedAt}`);
      }
    } finally {
      store.close();
    }
  });

program
  .command("report")
  .description("打开执行报告")
  .argument("[runId]", "缺省为最近一个 run")
  .option("-p, --project <id>", "按项目过滤最近 run")
  .action(async (runId: string | undefined, opts: { project?: string }) => {
    const store = openStore();
    try {
      let id = runId;
      if (id === undefined) {
        const rows = listRuns(store, { projectId: opts.project, limit: 1 });
        if (rows.length === 0) {
          errOut("还没有执行记录");
          process.exitCode = 1;
          return;
        }
        id = rows[0]?.id;
      }
      if (id === undefined) {
        errOut("找不到 run");
        process.exitCode = 1;
        return;
      }
      const run = getRun(store, id);
      if (run === null) {
        errOut(`run「${id}」不存在`);
        process.exitCode = 1;
        return;
      }
      const reportPath = path.join(DEFAULT_DATA_DIR, "projects", run.projectId, "runs", run.id, "report.html");
      out(reportPath);
      const { spawn } = await import("node:child_process");
      const child = spawn("open", [reportPath], { stdio: "ignore", detached: true });
      child.unref();
    } finally {
      store.close();
    }
  });

program
  .command("project")
  .description("项目管理")
  .addCommand(
    new Command("add")
      .argument("<id>")
      .argument("<name>")
      .argument("<baseUrl>")
      .action(async (id: string, name: string, baseUrl: string) => {
        const store = openStore();
        try {
          const p = createProject(store, { id, name, baseUrl });
          out(`已创建项目 ${p.id} (${p.baseUrl})`);
        } catch (e) {
          errOut(e instanceof Error ? e.message : String(e));
          process.exitCode = 2;
        } finally {
          store.close();
        }
      }),
  )
  .addCommand(
    new Command("list").action(async () => {
      const store = openStore();
      try {
        for (const p of listProjects(store))
          out(`${p.id}\t${p.name}\t${p.baseUrl}`);
      } finally {
        store.close();
      }
    }),
  );

program
  .command("var")
  .description("项目变量管理")
  .addCommand(
    new Command("set")
      .argument("<projectId>")
      .argument("<key=value>")
      .option("--secret", "加密存储")
      .option("--note <text>", "说明", "")
      .action(
        async (
          projectId: string,
          kv: string,
          opts: { secret?: boolean; note?: string },
        ) => {
          const eq = kv.indexOf("=");
          if (eq <= 0) {
            errOut("格式：var set <projectId> <KEY=value>");
            process.exitCode = 2;
            return;
          }
          const store = openStore();
          try {
            setVar(store, projectId, {
              key: kv.slice(0, eq),
              value: kv.slice(eq + 1),
              isSecret: opts.secret === true,
              note: opts.note,
            });
            out(`已保存 ${kv.slice(0, eq)}`);
          } catch (e) {
            errOut(e instanceof Error ? e.message : String(e));
            process.exitCode = 2;
          } finally {
            store.close();
          }
        },
      ),
  )
  .addCommand(
    new Command("list")
      .argument("<projectId>")
      .action(async (projectId: string) => {
        const store = openStore();
        try {
          for (const v of listVars(store, projectId)) {
            out(
              `${v.key}\t${v.value}\t${v.isSecret ? "secret" : ""}\t${v.note}`,
            );
          }
        } finally {
          store.close();
        }
      }),
  );

program.parseAsync(process.argv).catch((e: unknown) => {
  errOut(`命令执行失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
