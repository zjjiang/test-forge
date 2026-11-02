import type { RunResult, StepResult } from '../runner/types.js';

const esc = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS_ZH: Record<string, string> = {
	passed: '通过',
	failed: '失败',
	needs_review: '待人工复核',
	skipped: '跳过',
	warned: '警告',
	running: '执行中',
};

export const statusZh = (s: string): string => STATUS_ZH[s] ?? s;

function badge(status: string): string {
	return `<span class="b b-${esc(status)}">${esc(statusZh(status))}</span>`;
}

function stepRow(st: StepResult, i: number): string {
	const attempts = st.attempts
		.map((a) => `<div class="att">#${a.n} ${a.ok ? '成功' : '失败'} ${a.ms}ms${a.error ? ` — ${esc(a.error)}` : ''}</div>`)
		.join('');
	const asserts = st.assertions
		.map(
			(a) =>
				`<tr><td>${esc(a.type)}</td><td><span class="tag tag-${a.kind}">${a.kind === 'det' ? '确定性' : 'AI'}</span></td><td>${esc(a.expectedText)}</td><td class="mut">${esc(a.actualText)}</td><td>${a.ok ? '✓' : '✗'}</td></tr>`,
		)
		.join('');
	const shots = st.shots
		.map((f, n) => `<figure><img src="${esc(f)}" alt="step ${i + 1} shot ${n + 1}" loading="lazy"><figcaption>${esc(f)}</figcaption></figure>`)
		.join('');
	return `<section class="step st-${esc(st.status)}" id="s${i}">
<details open><summary><span class="idx">${String(i + 1).padStart(2, '0')}</span> <b>${esc(st.stepId)}</b> <span class="mut">${esc(st.type)} · 角色 ${esc(st.actor)} · ${st.ms}ms</span> ${badge(st.status)}</summary>
${st.expect ? `<p class="accept">验收点：${esc(st.expect)}</p>` : ''}
${st.error ? `<p class="err">${esc(st.error)}</p>` : ''}
${attempts}
${asserts ? `<table><tr><th>断言</th><th>类型</th><th>预期</th><th>实际</th><th>结果</th></tr>${asserts}</table>` : ''}
<div class="shots">${shots}</div>
</details></section>`;
}

/** 生成自包含的 report.html：相对路径引用截图，整个 run 目录可拷走。 */
export function renderReport(r: RunResult, warnings: readonly string[] = []): string {
	const det = r.steps.flatMap((s) => s.assertions).filter((a) => a.kind === 'det');
	const ai = r.steps.flatMap((s) => s.assertions).filter((a) => a.kind === 'ai');
	const warnHtml = warnings.length
		? `<div class="warnbox">${warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>`
		: '';
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TestForge ${esc(r.scenarioName)} ${esc(r.runId)}</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#dde1e8;--fg:#1a2030;--mut:#5d6679;--ok:#24804a;--bad:#c2362f;--rev:#b86a00;--warn-bg:#fff5e6}
body{margin:0;font:14px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--fg);background:var(--bg);padding:24px 16px 60px}
.wrap{max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.meta{color:var(--mut);font-size:13px;margin-bottom:16px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stats span{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 14px;font-size:13px}
.stats b{font-size:16px}
.b{padding:1px 9px;border-radius:3px;font-size:12px;color:#fff;white-space:nowrap}
.b-passed,.b-running{background:var(--ok)}.b-failed{background:var(--bad)}.b-needs_review{background:var(--rev)}.b-skipped,.b-warned{background:#79808c}
.step{background:var(--card);border:1px solid var(--line);border-radius:6px;margin-bottom:10px}
.step summary{cursor:pointer;padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.step .idx{color:var(--mut);font-variant-numeric:tabular-nums}
.st-failed{border-left:4px solid var(--bad)}.st-warned{border-left:4px solid var(--rev)}.st-passed{border-left:4px solid var(--ok)}
.step details[open] summary{border-bottom:1px solid var(--line)}
.step>details{padding-bottom:12px}
.accept{margin:10px 14px 0}
.err{color:var(--bad);margin:8px 14px 0;font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}
.att{font-family:ui-monospace,Menlo,monospace;font-size:12px;margin:4px 14px 0;color:var(--mut)}
table{border-collapse:collapse;margin:10px 14px 0;width:calc(100% - 28px)}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.mut{color:var(--mut)}
.tag{font-size:11px;padding:0 6px;border-radius:3px;border:1px solid}
.tag-det{color:var(--ok);border-color:var(--ok)}.tag-ai{color:var(--rev);border-color:var(--rev)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;padding:12px 14px 0}
.shots img{width:100%;border:1px solid var(--line);border-radius:4px;background:#fff}
.shots figcaption{font-size:11px;color:var(--mut);margin-top:2px;overflow-wrap:anywhere}
.warnbox{background:var(--warn-bg);border:1px solid #f0cf9a;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:13px}
@media (max-width:600px){.shots{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1>${esc(r.scenarioName)} ${badge(r.status)}</h1>
<div class="meta">run ${esc(r.runId)} · 项目 ${esc(r.projectId)} · ${esc(r.startedAt)} → ${esc(r.finishedAt)} · ${(r.durationMs / 1000).toFixed(1)}s</div>
<div class="stats">
<span>步骤 <b>${r.steps.length}</b></span>
<span>确定性断言 <b>${det.filter((a) => a.ok).length}/${det.length}</b></span>
<span>AI 断言 <b>${ai.filter((a) => a.ok).length}/${ai.length}</b></span>
<span>警告 <b>${r.warnings.length + warnings.length}</b></span>
</div>
${warnHtml}
${r.steps.map(stepRow).join('')}
<p class="meta">TestForge · trace-*.zip 与 summary.json 在同目录</p>
</div></body></html>`;
}
