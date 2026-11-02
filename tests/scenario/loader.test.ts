import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadScenarioDir, loadScenarioFile, loadScenarios } from '../../src/scenario/loader.js';

const dir = await mkdtemp(path.join(tmpdir(), 'tf-loader-'));

const validYaml = `name: 新店开通
baseUrl: http://127.0.0.1:5005
actors:
  admin: {}
  shop: {}
steps:
  - type: navigate
    url: /login
  - type: fill
    selector: "#user"
    value: admin
teardown:
  - type: click
    selector: "#stop"
    as: admin
`;

const invalidYaml = `name: 坏场景
baseUrl: 127.0.0.1
actors: {}
steps: []
`;

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('loadScenarioFile', () => {
	it('加载合法场景', async () => {
		const file = path.join(dir, 'ok.yaml');
		await writeFile(file, validYaml);
		const r = await loadScenarioFile(file);
		expect(r.result.ok).toBe(true);
		if (r.result.ok) expect(r.result.scenario.name).toBe('新店开通');
	});

	it('对缺失文件返回结构化错误而不是抛异常', async () => {
		const r = await loadScenarioFile(path.join(dir, 'nope.yaml'));
		expect(r.result.ok).toBe(false);
		if (!r.result.ok) expect(r.result.issues[0]).toContain('无法读取文件');
	});

	it('对坏 YAML 返回结构化错误', async () => {
		const file = path.join(dir, 'broken.yaml');
		await writeFile(file, 'steps: [ { type: ');
		const r = await loadScenarioFile(file);
		expect(r.result.ok).toBe(false);
		if (!r.result.ok) expect(r.result.issues[0]).toContain('YAML 解析失败');
	});

	it('对 schema 违例给出字段级问题清单', async () => {
		const file = path.join(dir, 'bad.yaml');
		await writeFile(file, invalidYaml);
		const r = await loadScenarioFile(file);
		expect(r.result.ok).toBe(false);
		if (!r.result.ok) {
			expect(r.result.issues.join(';')).toContain('baseUrl');
			expect(r.result.issues.join(';')).toContain('steps');
		}
	});
});

describe('loadScenarioDir / loadScenarios', () => {
	it('目录扫描按文件名排序，跳过非 yaml 文件', async () => {
		const sub = path.join(dir, 'scenarios');
		await mkdir(sub);
		await writeFile(path.join(sub, 'b.yaml'), validYaml);
		await writeFile(path.join(sub, 'a.yml'), validYaml);
		await writeFile(path.join(sub, 'notes.md'), '# 忽略');
		const rs = await loadScenarioDir(sub);
		expect(rs.map((r) => path.basename(r.sourcePath))).toEqual(['a.yml', 'b.yaml']);
		expect(rs.every((r) => r.result.ok)).toBe(true);
	});

	it('loadScenarios 对文件路径只加载该文件', async () => {
		const file = path.join(dir, 'single.yaml');
		await writeFile(file, validYaml);
		const rs = await loadScenarios(file);
		expect(rs).toHaveLength(1);
		expect(rs[0]?.result.ok).toBe(true);
	});
});
