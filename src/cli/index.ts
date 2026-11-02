import { Command } from 'commander';
import { loadScenarios } from '../scenario/loader.js';
import { errOut, out } from './io.js';

const program = new Command();

program
	.name('test-forge')
	.description('场景驱动的 AI 原生测试平台')
	.version('0.1.0');

program
	.command('validate')
	.description('校验场景 YAML（文件或目录）')
	.argument('<targets...>', '场景文件或目录，可多个')
	.option('--json', '输出机器可读的 JSON 结果')
	.action(async (targets: string[], opts: { json?: boolean }) => {
		const files: { sourcePath: string; result: import('../scenario/schema.js').ParseResult }[] = [];
		for (const t of targets) {
			try {
				files.push(...(await loadScenarios(t)));
			} catch (e) {
				files.push({
					sourcePath: t,
					result: { ok: false, issues: [`无法读取路径: ${e instanceof Error ? e.message : String(e)}`] },
				});
			}
		}
		if (opts.json) {
			out(JSON.stringify({
				success: files.every((f) => f.result.ok),
				data: files.map((f) => ({
					file: f.sourcePath,
					valid: f.result.ok,
					errors: f.result.ok ? [] : f.result.issues,
				})),
				error: null,
				meta: { total: files.length, valid: files.filter((f) => f.result.ok).length },
			}, null, 2));
			if (!files.length) errOut('警告：目标路径里没有找到任何场景文件');
			process.exitCode = files.some((f) => !f.result.ok) || !files.length ? 1 : 0;
			return;
		}
		if (!files.length) {
			errOut('目标路径里没有找到任何场景文件（只扫描 .yaml/.yml）');
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
	.command('run')
	.description('执行场景（MVP 实现中）')
	.argument('<target>', '场景文件或目录')
	.option('--json', '输出机器可读的 JSON 结果')
	.action(() => {
		errOut('run 尚未实现：runner 模块在后续提交中提供');
		process.exitCode = 2;
	});

program.parseAsync(process.argv).catch((e: unknown) => {
	errOut(`命令执行失败: ${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = 2;
});
