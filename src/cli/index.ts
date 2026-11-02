import { Command, InvalidArgumentError } from "commander";
import { loadScenarios } from "../scenario/loader.js";
import { errOut, out } from "./io.js";
import { openStore, DEFAULT_DB_PATH } from "../store/db.js";
import { getProject, createProject, listProjects } from "../store/projects.js";
import { setVar, listVars } from "../store/vars.js";
import { runScenario } from "../runner/./runner.js";
import type { RunResult } from "../runner/types.js";
import path from "node:path";

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
