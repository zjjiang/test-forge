import type { Browser, BrowserContext, Cookie, Page } from "playwright";

declare const window: {
  __TEST_CONTEXT__?: unknown;
  localStorage: { setItem(k: string, v: string): void };
  sessionStorage: { setItem(k: string, v: string): void };
};
import type { ActorConfig, Mock } from "../scenario/schema.js";

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  body: string | null;
}

export interface ActorRuntime {
  name: string;
  context: BrowserContext;
  page: Page;
  network: NetworkEntry[];
}

export interface ActorEnvOptions {
  baseUrl: string;
  blockedRoutes: string[];
  log: (line: string) => void;
}

export function routeMatcher(pattern: string): (url: URL) => boolean {
  const hasWildcard = pattern.includes("*");
  const re = hasWildcard
    ? new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
    : null;
  return (url: URL): boolean => (re !== null ? re.test(url.href) : url.href.includes(pattern));
}

export function pickMock(mocks: Mock[], method: string, url: string): Mock | undefined {
  return mocks.find((m) => {
    const methodOk = m.method === undefined || m.method === method.toUpperCase();
    return methodOk && routeMatcher(m.url)(new URL(url, "http://placeholder.invalid"));
  });
}

async function applyMocksAndGuards(
  context: BrowserContext,
  opts: ActorEnvOptions & { mocks: Mock[] },
): Promise<void> {
  for (const pattern of opts.blockedRoutes) {
    await context.route(routeMatcher(pattern), (route) => {
      opts.log("GUARD blocked " + route.request().method() + " " + route.request().url());
      return route.abort("blockedbyclient");
    });
  }
  for (const m of opts.mocks) {
    await context.route(routeMatcher(m.url), async (route) => {
      const req = route.request();
      if (m.method !== undefined && m.method !== req.method().toUpperCase()) return route.fallback();
      if (m.delayMs !== undefined && m.delayMs > 0) await new Promise((r) => setTimeout(r, m.delayMs));
      if (m.abort === true) return route.abort("blockedbyclient");
      const status = m.status ?? 200;
      const headers: Record<string, string> = { ...(m.headers ?? {}) };
      if (m.body !== undefined || m.fixture !== undefined) headers["content-type"] = "application/json";
      if (m.fixture !== undefined) {
        const { readFile } = await import("node:fs/promises");
        const text = await readFile(m.fixture, "utf8");
        return route.fulfill({ status, headers, body: text });
      }
      const body = m.body !== undefined ? JSON.stringify(m.body) : "";
      return route.fulfill({ status, headers, body });
    });
  }
}

export interface OpenActorInput {
  browser: Browser;
  name: string;
  actor: ActorConfig;
  baseUrl: string;
  blockedRoutes: string[];
  log: (line: string) => void;
}

export async function openActor(input: OpenActorInput): Promise<ActorRuntime> {
  const { browser, name, actor, baseUrl } = input;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const network: NetworkEntry[] = [];
  context.on("response", (res) => {
    const entry: NetworkEntry = { url: res.url(), method: res.request().method(), status: res.status(), body: null };
    network.push(entry);
    res.text().then(
      (t) => { entry.body = t.slice(0, 20000); },
      () => { /* binary or body already disposed */ },
    );
  });
  await applyMocksAndGuards(context, { ...input, mocks: actor.mocks ?? [] });
  await context.addInitScript((testContext: unknown) => {
    (window as { __TEST_CONTEXT__?: unknown }).__TEST_CONTEXT__ = testContext;
  }, { scenario: name, ...(actor.initVars ?? {}) });
  if (actor.localStorage !== undefined || actor.sessionStorage !== undefined) {
    await context.addInitScript((storage: { local: Record<string, string>; session: Record<string, string> }) => {
      for (const [k, v] of Object.entries(storage.local)) window.localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(storage.session)) window.sessionStorage.setItem(k, v);
    }, { local: actor.localStorage ?? {}, session: actor.sessionStorage ?? {} });
  }
  if (actor.cookies !== undefined && actor.cookies.length > 0) {
    const cookies = actor.cookies.map((c) =>
      c.domain === undefined
        ? ({ name: c.name, value: c.value, url: baseUrl } as unknown as Cookie)
        : ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly } as Cookie),
    );
    await context.addCookies(cookies);
  }
  if (actor.clock?.now !== undefined) {
    await context.clock.setFixedTime(new Date(actor.clock.now));
  }
  const page = await context.newPage();
  return { name, context, page, network };
}
