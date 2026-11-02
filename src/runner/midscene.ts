import type { Page } from 'playwright';
import type { AIDriver } from './actions.js';

/** Midscene 需要的三件套（GLM 模型族）：模型名 / 网关地址 / API Key。 */
export function midsceneConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.MIDSCENE_MODEL_NAME && env.MIDSCENE_MODEL_BASE_URL && env.MIDSCENE_MODEL_API_KEY);
}

interface AgentLike {
	aiAction(instruction: string): Promise<unknown>;
	aiAssert(expected: string): Promise<boolean | void>;
}

/** 每个 page 缓存一个 agent，避免重复创建。 */
export async function createMidsceneDriver(env: NodeJS.ProcessEnv = process.env): Promise<AIDriver> {
	const mod = await import('@midscene/web/playwright');
	mod.overrideAIConfig({
		MIDSCENE_MODEL_NAME: env.MIDSCENE_MODEL_NAME ?? '',
		MIDSCENE_MODEL_BASE_URL: env.MIDSCENE_MODEL_BASE_URL ?? '',
		MIDSCENE_MODEL_API_KEY: env.MIDSCENE_MODEL_API_KEY ?? '',
		MIDSCENE_MODEL_FAMILY: env.MIDSCENE_MODEL_FAMILY ?? 'anthropic',
	});
	const agents = new WeakMap<Page, AgentLike>();
	const agentFor = (page: Page): AgentLike => {
		const cached = agents.get(page);
		if (cached !== undefined) return cached;
		const agent = new mod.PlaywrightAgent(page) as unknown as AgentLike;
		agents.set(page, agent);
		return agent;
	};
	return {
		async act(instruction: string, page: Page): Promise<void> {
			await agentFor(page).aiAction(instruction);
		},
		async assert(expected: string, page: Page): Promise<boolean> {
			const r = await agentFor(page).aiAssert(expected);
			return r !== false;
		},
	};
}
