import { describe, expect, it } from 'vitest';
import { verdict } from '../../src/runner/verdict.js';
import type { StepResult, AssertionRecord } from '../../src/runner/types.js';

function step(partial: Partial<StepResult>): StepResult {
	return {
		index: 0,
		stepId: 's',
		type: 'click',
		actor: 'user',
		expect: '',
		status: 'passed',
		ms: 1,
		attempts: [],
		assertions: [],
		error: '',
		shots: [],
		...partial,
	};
}

function det(ok: boolean): AssertionRecord {
	return { stepId: 's', type: 'dom_assert', kind: 'det', expectedText: 'x', actualText: '', ok, at: '' };
}

function ai(ok: boolean): AssertionRecord {
	return { stepId: 's', type: 'visual_assert', kind: 'ai', expectedText: 'x', actualText: '', ok, at: '' };
}

describe('verdict', () => {
	it('有失败步骤 → failed', () => {
		expect(verdict([step({ status: 'passed', assertions: [det(true)] }), step({ status: 'failed' })])).toBe('failed');
	});

	it('确定性断言通过 → passed', () => {
		expect(verdict([step({ status: 'passed', assertions: [det(true)] })])).toBe('passed');
	});

	it('只有 AI 断言通过 → needs_review', () => {
		expect(verdict([step({ status: 'passed', assertions: [ai(true)] })])).toBe('needs_review');
	});

	it('确定性失败但 onFail=warn（状态 warned）不翻车，仍按断言判 passed', () => {
		expect(verdict([step({ status: 'warned', assertions: [det(false)] }), step({ status: 'passed', assertions: [det(true)] })])).toBe('passed');
	});

	it('全部 skipped → skipped', () => {
		expect(verdict([step({ status: 'skipped' }), step({ status: 'skipped' })])).toBe('skipped');
	});

	it('空列表 → skipped', () => {
		expect(verdict([])).toBe('skipped');
	});
});
