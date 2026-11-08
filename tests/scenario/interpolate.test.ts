import { describe, expect, it } from 'vitest';
import {
	InterpolationError,
	interpolate,
	interpolateDeep,
	resolveVarPath,
} from '../../src/scenario/interpolate.js';

describe('interpolate', () => {
	it('替换 ${var:NAME} 引用', () => {
		expect(interpolate('${var:HOST}/login', { HOST: 'http://datasrc-url' })).toBe('http://datasrc-url/login');
	});

	it('值会被字符串化', () => {
		expect(interpolate('前缀-${var:N}', { N: 42 })).toBe('前缀-42');
	});

	it('同一字符串里多处引用', () => {
		expect(interpolate('${var:A}:${var:B}', { A: 'x', B: 1 })).toBe('x:1');
	});

	it('没有引用时原样返回', () => {
		expect(interpolate('/plain/path', {})).toBe('/plain/path');
	});

	it('未定义变量抛 InterpolationError，并列出可用变量', () => {
		expect(() => interpolate('${var:NOPE}', { HAVE: 1 })).toThrow(InterpolationError);
		try {
			interpolate('${var:NOPE}', { HAVE: 1 });
		} catch (e) {
			expect((e as InterpolationError).message).toContain('HAVE');
			expect((e as InterpolationError).message).toContain('NOPE');
		}
	});

	it('null/undefined 导出同样报错', () => {
		expect(() => interpolate('${var:N}', { N: null })).toThrow(InterpolationError);
	});
});

describe('interpolateDeep', () => {
	it('深入对象与数组，返回新对象', () => {
		const input = { a: '${var:X}', list: ['${var:X}', 2], n: { deep: '${var:Y}' } };
		const out = interpolateDeep(input, { X: 'v', Y: 3 });
		expect(out).toEqual({ a: 'v', list: ['v', 2], n: { deep: '3' } });
		expect(out).not.toBe(input);
		expect(input.a).toBe('${var:X}');
	});

	it('非字符串值原样保留', () => {
		expect(interpolateDeep({ n: 5, b: true, nil: null }, {})).toEqual({ n: 5, b: true, nil: null });
	});
});

describe('interpolate ${today:N}', () => {
	const expected = (offset: number): string => {
		const d = new Date();
		d.setDate(d.getDate() + offset);
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${d.getFullYear()}-${m}-${day}`;
	};

	it('${today:0} 是今天', () => {
		expect(interpolate('check_in=${today:0}', {})).toBe(`check_in=${expected(0)}`);
	});

	it('${today:1} 是明天', () => {
		expect(interpolate('${today:1}', {})).toBe(expected(1));
	});

	it('负偏移 ${today:-1} 是昨天', () => {
		expect(interpolate('${today:-1}', {})).toBe(expected(-1));
	});

	it('与 ${var:} 混用', () => {
		expect(interpolate('${var:BASE}/api?d=${today:0}', { BASE: 'http://datasrc-api' })).toBe(
			`http://datasrc-api/api?d=${expected(0)}`,
		);
	});
});

describe('resolveVarPath 点路径', () => {
	const vars = { claim: { data: { tasks: [1, 2] }, code: 0 }, n: 5 };

	it('点路径逐层取值', () => {
		expect(resolveVarPath('claim.code', vars)).toBe(0);
		expect(resolveVarPath('n', vars)).toBe(5);
	});

	it('${var:ITEM.field} 插值到字符串', () => {
		expect(interpolate('/x/${var:claim.code}', vars)).toBe('/x/0');
	});

	it('缺字段抛 InterpolationError', () => {
		expect(() => resolveVarPath('claim.nope', vars)).toThrow(InterpolationError);
	});

	it('标量中途下钻报错', () => {
		expect(() => resolveVarPath('n.x', vars)).toThrow(InterpolationError);
	});
});
