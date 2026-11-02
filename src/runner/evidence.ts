import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "./types.js";

export class Evidence {
  readonly dir: string;
  private readonly logPath: string;
  private nShot = 0;

  constructor(
    dataDir: string,
    readonly runId: string,
    readonly projectId: string,
  ) {
    this.dir = path.join(dataDir, "projects", projectId, "runs", runId);
    this.logPath = path.join(this.dir, "execution.log");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.shotsDir(), { recursive: true });
  }

  shotsDir(): string {
    return path.join(this.dir, "screenshots");
  }

  /** download 步骤的落盘位置：downloads/ 下，文件名冲突时加序号。 */
  filePath(...parts: string[]): string {
    let target = path.join(this.dir, ...parts);
    if (path.extname(target) !== "") {
      const ext = path.extname(target);
      const stem = target.slice(0, -ext.length);
      let n = 1;
      while (existsSync(target)) {
        target = `${stem}-${n}${ext}`;
        n += 1;
      }
    }
    mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }

  log(line: string): void {
    appendFileSync(this.logPath, new Date().toISOString() + " " + line + "\n");
  }

  /** 每步截图：01-name-before.png / 01-name-after.png，序号全局递增。 */
  shotPath(stepLabel: string, phase: "before" | "after" | "fail"): string {
    this.nShot += 1;
    const nn = String(this.nShot).padStart(2, "0");
    return path.join(this.shotsDir(), `${nn}-${stepLabel}-${phase}.png`);
  }

  writeSummary(result: RunResult): void {
    writeFileSync(
      path.join(this.dir, "summary.json"),
      JSON.stringify(result, null, 2),
    );
  }

  writeJson(name: string, data: unknown): void {
    writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 2));
  }

  writeText(name: string, text: string): void {
    writeFileSync(path.join(this.dir, name), text);
  }
}
