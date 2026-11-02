/** CLI 输出统一走这里，避免散落的 console.log。 */
export const out = (line: string): void => {
	process.stdout.write(line + '\n');
};

export const errOut = (line: string): void => {
	process.stderr.write(line + '\n');
};
