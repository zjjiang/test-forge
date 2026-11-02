/** 用脱敏表把日志/快照文件内容里的 secret 值替换成掩码。 */
export type RedactTable = Readonly<Record<string, string>>;

export function makeRedactor(table: RedactTable): (s: string) => string {
	const secrets: string[] = Object.values(table).filter((v) => v && v.length >= 4);
	return (s: string): string => {
		let result = s;
		for (const v of secrets) {
			if (result.includes(v)) result = result.split(v).join('********');
		}
		return result;
	};
}
