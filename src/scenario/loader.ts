import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseScenario, type ParseResult } from './schema.js';

export interface LoadedScenario {
	/** 场景文件（或目录）绝对路径 */
	sourcePath: string;
	result: ParseResult;
}

/** 读单个 YAML 文件并校验；文件不存在/不是合法 YAML 也返回结构化错误，不抛异常。 */
export async function loadScenarioFile(filePath: string): Promise<LoadedScenario> {
	const sourcePath = path.resolve(filePath);
	let raw: string;
	try {
		raw = await readFile(sourcePath, 'utf8');
	} catch (err) {
		return {
			sourcePath,
			result: { ok: false, issues: [`无法读取文件: ${err instanceof Error ? err.message : String(err)}`] },
		};
	}
	let doc: unknown;
	try {
		doc = parseYaml(raw);
	} catch (err) {
		return {
			sourcePath,
			result: { ok: false, issues: [`YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`] },
		};
	}
	return { sourcePath, result: parseScenario(doc) };
}

const SCENARIO_EXT = new Set(['.yaml', '.yml']);

/** 读目录下所有 *.yaml/*.yml（不递归），按文件名排序。 */
export async function loadScenarioDir(dirPath: string): Promise<LoadedScenario[]> {
	const sourcePath = path.resolve(dirPath);
	const entries = await readdir(sourcePath, { withFileTypes: true });
	const files = entries
		.filter((e) => e.isFile() && SCENARIO_EXT.has(path.extname(e.name).toLowerCase()))
		.map((e) => path.join(sourcePath, e.name))
		.sort();
	return Promise.all(files.map((f) => loadScenarioFile(f)));
}

/** 文件或目录二选一，按实际类型分发。 */
export async function loadScenarios(target: string): Promise<LoadedScenario[]> {
	const st = await (await import('node:fs/promises')).stat(path.resolve(target));
	return st.isDirectory() ? loadScenarioDir(target) : loadScenarioFile(target).then((x) => [x]);
}
