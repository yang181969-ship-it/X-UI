import { expect, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { LEDGER_SEED, totp } from './fixtures.ts';

/** Helpers of the lifecycle and recovery journeys (M3-B4-D). Fictional data only. */

export const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);
export const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
export const PENDING_PREFIX = 'xui-v1-pending-write:';

export async function signIn(page: Page, user: { username: string; password: string }, secret: string, path = '/transactions') {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(user.username);
  await page.getByPlaceholder('密码').fill(user.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(secret));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
}

/** One API call from the signed-in page (same origin: cookie, Origin and CSRF header as the app sends them). */
export async function call<T = unknown>(page: Page, method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body, key }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { 'x-xui-csrf': '1', ...(body !== undefined && { 'content-type': 'application/json' }), ...(key && { 'Idempotency-Key': key }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body, key },
  );
}

let seq = 0;
export const newKey = () => `e2e-b4d-${Date.now()}-${++seq}`.padEnd(20, '0');

export async function accountIds(page: Page) {
  const list = (await call<{ id: string; name: string }[]>(page, 'GET', '/accounts?status=all')).json;
  const id = (name: string) => list.find((a) => a.name === name)!.id;
  return { hk: id(LEDGER_SEED.hk), us: id(LEDGER_SEED.us), cn: id(LEDGER_SEED.cn) };
}

export async function create(page: Page, body: Record<string, unknown>): Promise<string> {
  const r = await call<{ transactionId: string }>(page, 'POST', '/transactions', body, newKey());
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.transactionId;
}

export type Txn = { status: string; currentRevision: number; notes: string | null; event: Record<string, unknown>; entries: { direction: string; amount: number | null; amountStatus: string; accountId: string; currency: string; fundingAccountCountry: string; countrySource: string }[] };
export const getTxn = async (page: Page, id: string) => (await call<Txn>(page, 'GET', `/transactions/${id}`)).json;

const base = { recordMode: 'current', occurredTime: null, postedOn: null, cardId: null, paymentChannelId: null, transferMethod: null, counterparty: null, notes: null };
type Entry = { direction: 'out' | 'in'; accountId: string; currency: string; amount: number | null; ack?: boolean };
const entries = (list: Entry[]) => list.map((e) => ({ direction: e.direction, accountId: e.accountId, currency: e.currency, amountStatus: e.amount === null ? 'pending' : 'confirmed', amount: e.amount, closedCurrencyAck: e.ack ?? false }));

/** A merchant spend body. */
export const spend = (o: { merchant: string; country: string | null; currency: string; amount: number; entry: Entry; daysAgo?: number; recordMode?: 'current' | 'backfill' }) => ({
  ...base,
  type: 'merchant_spend',
  recordMode: o.recordMode ?? 'current',
  occurredOn: day(o.daysAgo ?? 5),
  eventCurrency: o.currency,
  eventAmount: o.amount,
  merchantName: o.merchant,
  merchantCountry: o.country,
  entries: entries([o.entry]),
});

export const ownTransfer = (o: { currency: string; amount: number; out: Entry; in: Entry; daysAgo?: number }) => ({
  ...base,
  type: 'own_transfer',
  occurredOn: day(o.daysAgo ?? 5),
  eventCurrency: o.currency,
  eventAmount: o.amount,
  merchantName: null,
  merchantCountry: null,
  entries: entries([o.out, o.in]),
});

/** A fact_correction body from the current version (API), with changes. */
export async function factBody(page: Page, id: string, change: (facts: Record<string, unknown>) => void, reason = 'E2E 更正') {
  const t = await getTxn(page, id);
  const e = t.event as Record<string, unknown>;
  const cp = e.counterparty as Record<string, unknown> | null;
  const facts: Record<string, unknown> = {
    recordMode: e.recordMode,
    occurredOn: e.occurredOn,
    occurredTime: e.occurredTime,
    postedOn: e.postedOn,
    eventCurrency: e.eventCurrency,
    eventAmount: e.eventAmount,
    merchantName: e.merchantName,
    merchantCountry: e.merchantCountry,
    cardId: e.cardId,
    paymentChannelId: e.paymentChannelId,
    transferMethod: e.transferMethod,
    counterparty: cp && (cp.name ?? cp.country ?? cp.institution ?? cp.accountHint) ? { name: cp.name, country: cp.country, institution: cp.institution, accountHint: cp.accountHint } : null,
    entries: t.entries.map((x) => ({ direction: x.direction, accountId: x.accountId, currency: x.currency, amountStatus: x.amountStatus, amount: x.amount, closedCurrencyAck: false })),
  };
  change(facts);
  return { kind: 'fact_correction', baseRevision: t.currentRevision, reason, ...facts };
}

/** Choose an option in the antd Select labelled `label` (typing filters a virtual list). */
export async function pick(page: Page, label: string, option: string | RegExp, type = true, scope: Locator = page.locator('body')) {
  const input = scope.getByLabel(label, { exact: true });
  await input.click();
  if (type && typeof option === 'string') await input.pressSequentially(option);
  const listId = await input.getAttribute('aria-controls');
  const popup = listId ? page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) }) : page.locator('.ant-select-dropdown:visible').last();
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

/** POSTs to `glob` seen by the page (key, body) while the handler answers them. */
export function interceptWrites(page: Page, glob: string, handler: (route: Route, n: number) => Promise<void>) {
  const seen: { key: string | null; body: string | null }[] = [];
  const h = async (route: Route, request: Request) => {
    if (request.method() !== 'POST') return route.continue();
    seen.push({ key: request.headers()['idempotency-key'] ?? null, body: request.postData() });
    return handler(route, seen.length);
  };
  return { seen, on: () => page.route(glob, h), off: () => page.unroute(glob, h) };
}

/** The server commits; the browser never receives the answer. */
export const commitThenDrop = async (route: Route) => {
  await route.fetch();
  await route.abort('connectionreset');
};

export const storedKeys = (page: Page) => page.evaluate((p) => Object.keys(sessionStorage).filter((k) => k.startsWith(p)), PENDING_PREFIX);
export const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
/** Wait for a drawer's / modal's open transition (screenshots); endless animations (spinners) are not waited for. */
export const settled = (l: Locator) => l.evaluate((el) => Promise.all((el.closest('.ant-drawer, .ant-modal-wrap') ?? el).getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
