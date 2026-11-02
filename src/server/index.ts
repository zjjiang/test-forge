import { buildApp } from "./api.js";

const port = Number(process.env.TESTFORGE_PORT ?? 3300);
const host = process.env.TESTFORGE_HOST ?? "127.0.0.1";

const app = buildApp();
app
  .listen({ port, host })
  .then(() => {
    process.stdout.write(`TestForge 控制台: http://${host}:${port}\n`);
  })
  .catch((e: unknown) => {
    process.stderr.write(`启动失败: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
