import { describe, expect, it } from 'vitest';
import { InterpolationError, interpolate, interpolateDeep } from '../../src/scenario/interpolate.js';

describe('interpolate', () => {
	it('替换 ${var:NAME} 引用', () => {
		expect(interpolate('${var:HOST}/login', { HOST: 'http://localhost:5005' })).toBe('http://localhost:5005/login');
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

	it('null/undefined 值同样报错', () => {
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
