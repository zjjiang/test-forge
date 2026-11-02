import type { StepResult, RunStatus } from './types.js';

/**
 * 判定规则：
 * - 任一 fail 级步骤失败 → failed
 * - 没有 fail 级失败，但存在确定性断言且至少一条通过 → passed
 * - 只有 AI 断言通过（无确定性断言）→ needs_review（AI 说了不算，人复核）
 * - 全部 skipped → skipped
 */
export function verdict(results: readonly StepResult[]): RunStatus {
	if (results.length === 0) return 'skipped';
	const failSteps = results.filter((r) => r.status === 'failed');
	if (failSteps.length > 0) return 'failed';
	const executed = results.filter((r) => r.status !== 'skipped');
	if (executed.length === 0) return 'skipped';
	const detOk = executed.some((r) => r.assertions.some((a) => a.kind === 'det' && a.ok));
	return detOk ? 'passed' : 'needs_review';
}
