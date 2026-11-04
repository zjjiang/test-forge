import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** TestForge 平台地址（默认本机 dev 端口）；调用时读取，便于测试注入。 */
function base(): string {
  return process.env.TESTFORGE_URL ?? "http://127.0.0.1:3300";
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error: string | null;
  code?: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base() + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (body === null) throw new Error(`HTTP ${res.status}（响应不是 JSON）`);
  if (!body.success) throw new Error(body.error ?? "未知错误");
  return body.data;
}

/** 触发运行并等待落库返回 runId（与 API 202 行为一致）。 */
async function triggerRun(projectId: string, file: string, triggeredBy: string): Promise<string> {
  const d = await call<{ runId: string }>(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ file, triggeredBy }),
  });
  return d.runId;
}

/** 注册全部工具；server.connect 之前调用。 */
export function registerTools(server: McpServer): void {
  server.tool(
    "list_projects",
    "列出 TestForge 里的所有测试项目",
    {},
    async () => {
      const d = await call<{ id: string; name: string; baseUrl: string; description: string }[]>("/api/projects");
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    },
  );

  server.tool(
    "list_scenarios",
    "列出某项目的全部场景（含校验状态与最近一次结果）",
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const d = await call<{ file: string; name: string; valid: boolean; steps: number; lastRun: { id: string; status: string } | null }[]>(
        `/api/projects/${encodeURIComponent(projectId)}/scenarios`,
      );
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    },
  );

  server.tool(
    "list_runs",
    "列出某项目最近的执行记录",
    { projectId: z.string().min(1), limit: z.number().int().min(1).max(100).default(10) },
    async ({ projectId, limit }) => {
      const d = await call<{ id: string; scenarioName: string; status: string; durationMs: number; startedAt: string }[]>(
        `/api/projects/${encodeURIComponent(projectId)}/runs?limit=${limit}`,
      );
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    },
  );

  server.tool(
    "run_scenario",
    "触发一个场景的执行（异步启动，返回 runId；用 get_run 轮询结果）",
    { projectId: z.string().min(1), file: z.string().min(1), triggeredBy: z.string().default("mcp") },
    async ({ projectId, file, triggeredBy }) => {
      const runId = await triggerRun(projectId, file, triggeredBy);
      return { content: [{ type: "text", text: `已启动：runId=${runId}。用 get_run(projectId, "${runId}") 轮询结果。` }] };
    },
  );

  server.tool(
    "get_run",
    "读取一次执行的结果：状态、每个环节与子步骤、失败详情、警告",
    { projectId: z.string().min(1), runId: z.string().min(1) },
    async ({ projectId, runId }) => {
      const d = await call<{ run: { status: string }; summary: Record<string, unknown> | null }>(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
      );
      if (d.summary === null) {
        return { content: [{ type: "text", text: `状态：${d.run.status}（还没有 summary，稍后再轮询）` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(d.summary, null, 2) }] };
    },
  );

  server.tool(
    "wait_run",
    "等待一次执行结束（每 3 秒轮询，最多 10 分钟），返回最终 summary",
    { projectId: z.string().min(1), runId: z.string().min(1) },
    async ({ projectId, runId }) => {
      const deadline = Date.now() + 600_000;
      for (;;) {
        const d = await call<{ run: { status: string }; summary: Record<string, unknown> | null }>(
          `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
        );
        if (d.summary !== null && d.run.status !== "running") {
          return { content: [{ type: "text", text: JSON.stringify(d.summary, null, 2) }] };
        }
        if (d.summary === null && d.run.status !== "running") {
          return { content: [{ type: "text", text: `run ${runId} 结束：${d.run.status}（无 summary，可能是 skipped）` }] };
        }
        if (Date.now() >= deadline) {
          return { content: [{ type: "text", text: `等待超时（10 分钟），run ${runId} 仍在 ${d.run.status}。稍后用 get_run 再查。` }] };
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
    },
  );

  server.tool(
    "get_screenshot",
    "读取一次执行的某张截图（返回图片，可直接查看）；先用 get_run 拿 summary 里的 shots 文件名",
    { projectId: z.string().min(1), runId: z.string().min(1), filename: z.string().min(1) },
    async ({ projectId, runId, filename }) => {
      if (filename.includes("..") || filename.includes("/")) throw new Error("filename 必须是 screenshots/ 下的裸文件名");
      const res = await fetch(`${base()}/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/files/screenshots/${encodeURIComponent(filename)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
    },
  );

  server.tool(
    "get_scenario_source",
    "读取场景的 YAML 与业务描述（Markdown）",
    { projectId: z.string().min(1), file: z.string().min(1) },
    async ({ projectId, file }) => {
      const d = await call<{ yaml: string; description: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(file)}/source`,
      );
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    },
  );

  server.tool(
    "save_scenario_yaml",
    "保存场景 YAML（服务端先跑 schema 校验，不通过会返回具体错误行）",
    { projectId: z.string().min(1), file: z.string().min(1), content: z.string().min(1) },
    async ({ projectId, file, content }) => {
      await call(`/api/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(file)}/yaml`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      return { content: [{ type: "text", text: `已保存 ${file}（schema 校验通过）` }] };
    },
  );

  server.tool(
    "save_scenario_description",
    "保存场景的业务描述（Markdown，存为同名 .md 文件）",
    { projectId: z.string().min(1), file: z.string().min(1), content: z.string().min(1) },
    async ({ projectId, file, content }) => {
      await call(`/api/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(file)}/description`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      return { content: [{ type: "text", text: `已保存描述（${file.replace(/\.ya?ml$/, ".md")}）` }] };
    },
  );
}
