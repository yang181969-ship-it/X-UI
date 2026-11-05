import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { CREATE_SEED, CREATE_TOTP_SECRET, CREATE_USER, totp } from './fixtures.ts';

/**
 * M3-B4-C browser journey: the create form for the four approved types, as its own user. Every
 * transaction goes through the real form and the real POST /api/transactions (Idempotency-Key).
 * Covered: spending-source prefill (exact / conversion / no match), touched fields never
 * overwritten, backfill (reference only, explicit apply, closed currency confirmed per entry,
 * declared home region), own transfers (two registered sides, one unregistered side with a
 * required, never pre-filled jurisdiction), third-party transfers (incoming with the sender's
 * amount unknown), confirmed-domestic refused by the server, undetermined saved; lost responses
 * (the server commits, the browser gets nothing): automatic retries with the same key and bytes,
 * sessionStorage recovery after a reload, a request in flight while the page goes away, abandoning
 * after a warning; sign-out clears the stored request; the phone layout.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

const form = () => page.locator('.txn-form');
const item = (label: string) => form().locator('.ant-form-item').filter({ has: page.locator('.ant-form-item-label', { hasText: new RegExp(`^${label}$`) }) });
const field = (label: string) => page.getByLabel(label, { exact: true });
const save = () => page.locator('.txn-submit').click();
const banner = () => page.locator('.txn-unknown');
const PENDING_PREFIX = 'xui-v1-pending-write:';
const storedKeys = () => page.evaluate((p) => Object.keys(sessionStorage).filter((k) => k.startsWith(p)), PENDING_PREFIX);

/** Choose an option in the antd Select labelled `label`. */
async function pick(label: string, option: string | RegExp, type = true) {
  const input = field(label);
  await input.click();
  if (type && typeof option === 'string') await input.pressSequentially(option);
  const listId = await input.getAttribute('aria-controls');
  const popup = listId ? page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) }) : page.locator('.ant-select-dropdown:visible').last();
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

async function openForm(type?: string) {
  await page.goto(`/transactions/new${type ? `?type=${type}` : ''}`);
  await expect(form()).toBeVisible();
}

/** Saved: the detail page of the new transaction; returns its id. */
async function expectSaved(text = '交易已保存'): Promise<string> {
  await expect(page).toHaveURL(/\/transactions\/[0-9a-z]{26}$/);
  await expect(page.locator('.ant-message')).toContainText(text);
  return page.url().split('/').pop()!;
}

async function countByQuery(q: string): Promise<number> {
  return page.evaluate(async (query) => {
    const res = await fetch(`/api/transactions?status=all&q=${encodeURIComponent(query)}`);
    return ((await res.json()) as { items: unknown[] }).items.length;
  }, q);
}

/** POSTs to /api/transactions seen by the page (method, key, body) while `fn` runs the route. */
function interceptCreates(handler: (route: Route, n: number) => Promise<void>) {
  const seen: { key: string | null; body: string | null }[] = [];
  const h = async (route: Route, request: Request) => {
    if (request.method() !== 'POST') return route.continue();
    seen.push({ key: request.headers()['idempotency-key'] ?? null, body: request.postData() });
    return handler(route, seen.length);
  };
  return { seen, on: () => page.route('**/api/transactions', h), off: () => page.unroute('**/api/transactions', h) };
}

/** The server commits; the browser never receives the answer. */
const commitThenDrop = async (route: Route) => {
  await route.fetch();
  await route.abort('connectionreset');
};

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  // Leaving a page with an unconfirmed request asks first (beforeunload): the journey confirms.
  page.on('dialog', (d) => void d.accept());
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected: the anonymous /auth/me probe (401), the refused confirmed-domestic request (400),
    // and the requests this journey drops on purpose (net::ERR_…).
    if (/the server responded with a status of (400|401)|net::ERR_/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in and opens the form from the list', async () => {
  await page.goto('/transactions');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(CREATE_USER.username);
  await page.getByPlaceholder('密码').fill(CREATE_USER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(CREATE_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  await page.locator('.txn-new').click();
  await expect(page).toHaveURL(/\/transactions\/new$/);
  await expect(form()).toHaveAttribute('data-type', 'merchant_spend');
  await expect(page.locator('.txn-type-switch')).toContainText('商户消费');
  await expect(page.locator('.txn-type-switch')).toContainText('第三方汇款');
});

test('merchant spend, exact currency: the recommendation fills account, currency and amount; touched fields are never overwritten', async () => {
  await field('商户').fill('Contoso Cafe');
  await pick('商户所在地', '(US)');
  await pick('银行卡', CREATE_SEED.linkedCard);
  await pick('交易币种', 'USD');
  await field('商户交易金额').fill('10.00');
  await expect(page.locator('.txn-recommendation')).toHaveAttribute('data-match', 'exact_currency');
  await expect(item('扣款账户')).toContainText(CREATE_SEED.hk);
  await expect(item('资金币种')).toContainText('USD');
  await expect(field('实际扣款金额')).toHaveValue('10.00');
  // The untouched funding amount follows the event amount…
  await field('商户交易金额').fill('12.00');
  await expect(field('实际扣款金额')).toHaveValue('12.00');
  // …until the user types it; then a later event amount never replaces it.
  await field('实际扣款金额').fill('12.35');
  await field('商户交易金额').fill('12.50');
  await expect(field('实际扣款金额')).toHaveValue('12.35');
  await shot(page, '70-create-spend-exact');
  await save();
  const id = await expectSaved();
  await expect(page.locator('.txn-snapshot .txn-entry-table')).toContainText('USD 12.35');
  await expect(page.locator('.txn-head')).toContainText('USD 12.50');
  await expect(page.locator('.txn-current')).toContainText(CREATE_SEED.linkedCard);
  expect(id).toBeTruthy();
});

test('conversion required: only the account is filled; the funding currency must be chosen; a pending amount is saved as pending', async () => {
  await openForm();
  await field('商户').fill('Fabrikam Store');
  await pick('商户所在地', '(JP)');
  await pick('银行卡', CREATE_SEED.linkedCard);
  await pick('交易币种', 'JPY');
  await field('商户交易金额').fill('1500');
  await expect(page.locator('.txn-recommendation')).toHaveAttribute('data-match', 'conversion_required');
  await expect(item('扣款账户')).toContainText(CREATE_SEED.hk);
  await expect(item('资金币种')).toContainText('选择币种');
  await field('扣款账户 · 金额待补录').click();
  await save();
  await expect(item('资金币种')).toContainText('必填');
  await pick('扣款账户 · 资金币种', 'HKD', false);
  await save();
  await expectSaved();
  await expect(page.locator('.txn-snapshot .txn-entry-table')).toContainText('HKD 待补录');
  await expect(page.locator('.txn-head')).toContainText('JPY 1,500');
});

test('no match: nothing is filled; switching to that card clears only what the recommendation had filled', async () => {
  await openForm();
  await pick('商户所在地', '(US)');
  await pick('银行卡', CREATE_SEED.linkedCard);
  await pick('交易币种', 'USD');
  await field('商户交易金额').fill('5');
  await expect(item('扣款账户')).toContainText(CREATE_SEED.hk);
  await pick('银行卡', CREATE_SEED.plainCard);
  await expect(page.locator('.txn-recommendation')).toHaveAttribute('data-match', 'no_match');
  await expect(item('扣款账户')).toContainText('选择账户');
  await expect(field('实际扣款金额')).toHaveValue('');
  await pick('扣款账户', CREATE_SEED.us);
  await pick('扣款账户 · 资金币种', 'USD', false);
  await field('实际扣款金额').fill('5');
  // A touched account survives switching back to the linked card.
  await pick('银行卡', CREATE_SEED.linkedCard);
  await expect(page.locator('.txn-recommendation')).toHaveAttribute('data-match', 'exact_currency');
  await expect(item('扣款账户')).toContainText(CREATE_SEED.us);
  await expect(field('实际扣款金额')).toHaveValue('5');
  await field('商户').fill('Northwind Kiosk');
  await save();
  await expectSaved();
  await expect(page.locator('.txn-current')).toContainText(CREATE_SEED.us);
});

test('backfill: the recommendation is a reference until applied; a closed currency is confirmed per entry; the home region is declared', async () => {
  await openForm();
  // Current mode: the closed EUR is offered but disabled.
  await pick('扣款账户', CREATE_SEED.hk);
  await field('扣款账户 · 资金币种').click();
  const eur = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'EUR' });
  await expect(eur).toHaveClass(/ant-select-item-option-disabled/);
  await expect(eur).toContainText('（已关闭）');
  await page.keyboard.press('Escape');

  await openForm();
  await form().getByText('历史补录', { exact: true }).click();
  await pick('当时的本国地区（可选）', '(HK)');
  await field('商户').fill('Tailspin Books');
  await pick('商户所在地', '(US)');
  await pick('银行卡', CREATE_SEED.linkedCard);
  await pick('交易币种', 'USD');
  await field('商户交易金额').fill('20');
  await expect(page.locator('.txn-recommendation')).toHaveAttribute('data-match', 'exact_currency');
  await expect(page.locator('.txn-recommendation')).toContainText('推荐只作参考，不会自动套用');
  await expect(item('扣款账户')).toContainText('选择账户');
  await page.locator('.txn-apply-rec').click();
  await expect(item('扣款账户')).toContainText(CREATE_SEED.hk);
  await expect(field('实际扣款金额')).toHaveValue('20.00');
  // A closed currency in a backfill: allowed, confirmed for this entry.
  await pick('扣款账户 · 资金币种', 'EUR', false);
  await field('实际扣款金额').fill('18.40');
  await save();
  await expect(page.locator('.txn-closed-ack')).toContainText('使用已关闭的币种需要勾选确认');
  await page.locator('.txn-closed-ack').getByRole('checkbox').check();
  await expect(page.locator('.txn-hints [data-hint="currency_closed"]')).toBeVisible();
  await shot(page, '71-create-backfill-closed-currency');
  await save();
  await expectSaved();
  const snap = page.locator('.txn-snapshot');
  await expect(snap).toContainText('历史补录');
  await expect(snap.locator('[data-field="currencyStatusAtSave"]')).toHaveText('已关闭');
  await expect(snap).toContainText('已逐条确认使用已关闭币种');
  await expect(snap.locator('[data-field="homeRegion"]')).toHaveText('香港 (HK)');
  await expect(snap).toContainText('补录时声明');
});

test('merchant refund: one incoming entry', async () => {
  await openForm('merchant_refund');
  await field('商户').fill('Contoso Cafe');
  await pick('商户所在地', '(US)');
  await pick('交易币种', 'HKD');
  await field('商户退款金额').fill('20');
  await pick('退款入账账户', CREATE_SEED.hk);
  await pick('退款入账账户 · 资金币种', 'HKD', false);
  await field('实际到账金额').fill('20');
  await save();
  await expectSaved();
  await expect(page.locator('.txn-head')).toContainText('商户退款');
  await expect(page.locator('.txn-snapshot .txn-entry-table [data-direction="in"]')).toContainText('HKD 20.00');
});

test('own transfer between two registered accounts, across currencies', async () => {
  await openForm('own_transfer');
  await expect(form()).toContainText('两侧都是已登记的账户');
  await pick('交易币种', 'HKD');
  await field('汇出本金（凭证）').fill('1000');
  await pick('转出账户', CREATE_SEED.hk);
  await pick('转出账户 · 资金币种', 'HKD', false);
  await field('转出账户 · 实际扣款金额').fill('1000');
  await pick('转入账户', CREATE_SEED.us);
  await pick('转入账户 · 资金币种', 'USD', false);
  await field('转入账户 · 实际到账金额').fill('128');
  await pick('转账方式', 'SWIFT', false);
  await shot(page, '72-create-own-both');
  await save();
  await expectSaved();
  const entries = page.locator('.txn-snapshot .txn-entry-table');
  await expect(entries.locator('tbody tr.ant-table-row')).toHaveCount(2);
  await expect(entries).toContainText('HKD 1,000.00');
  await expect(entries).toContainText('USD 128.00');
});

test('own transfer with one unregistered side: the jurisdiction is required and never pre-filled', async () => {
  await openForm('own_transfer');
  await form().getByText('一侧是未登记的本人账户', { exact: true }).click();
  await form().getByText('转入已登记账户', { exact: true }).click();
  await expect(item('对方账户法域')).toContainText('选择国家/地区');
  await expect(page.locator('.txn-counterparty-card')).toContainText('不会自动预填');
  await pick('交易币种', 'USD');
  await field('汇出本金（凭证）').fill('50');
  await pick('转入账户（已登记）', CREATE_SEED.us);
  await pick('转入账户（已登记） · 资金币种', 'USD', false);
  await field('实际到账金额').fill('49.50');
  await save();
  await expect(item('对方账户法域')).toContainText('必填');
  // The unregistered own side can never be "unknown".
  await field('对方账户法域').click();
  await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^未知$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await pick('对方账户法域', '(SG)');
  await save();
  await expectSaved();
  await expect(page.locator('.txn-head')).toContainText('本人调拨 · 转入');
  await expect(page.locator('.txn-snapshot [data-field="counterparty"]')).toContainText('新加坡 (SG)');
});

test('third-party transfers: sent with an unknown counterparty jurisdiction; received with the sender’s amount unknown (P8)', async () => {
  await openForm('third_party_transfer');
  await pick('交易币种', 'HKD');
  await field('汇出本金（凭证）').fill('500');
  await pick('汇出账户', CREATE_SEED.hk);
  await pick('汇出账户 · 资金币种', 'HKD', false);
  await field('实际扣款金额').fill('500');
  await field('对手方名称').fill('Northwind Traders');
  await pick('对方账户法域', '未知');
  await save();
  await expectSaved();
  await expect(page.locator('.txn-head')).toContainText('第三方汇款 · 汇出');

  await openForm('third_party_transfer');
  await form().getByText('汇入（他人汇来）', { exact: true }).click();
  await pick('收款账户', CREATE_SEED.us);
  await pick('收款账户 · 资金币种', 'USD', false);
  await field('实际到账金额').fill('50');
  await field('对手方名称').fill('Litware Ltd');
  await pick('对方账户法域', '(GB)');
  await save();
  await expect(item('对方汇出本金（凭证）')).toContainText('请输入金额');
  await form().getByText('对方金额未知', { exact: true }).click();
  await expect(field('对方汇出本金（凭证）')).toBeDisabled();
  await save();
  await expectSaved();
  await expect(page.locator('.txn-head')).toContainText('对方金额未知');
});

test('confirmed domestic is refused by the server (one request, nothing saved); with the merchant unknown it is saved as undetermined', async () => {
  const creates = interceptCreates((route) => route.continue());
  await creates.on();
  await openForm();
  await field('商户').fill('Domestic Bookshop');
  await pick('商户所在地', '(CN)');
  await pick('交易币种', 'CNY');
  await field('商户交易金额').fill('88');
  await pick('扣款账户', CREATE_SEED.cn);
  await pick('扣款账户 · 资金币种', 'CNY', false);
  await field('实际扣款金额').fill('88');
  await save();
  const error = page.locator('.txn-form-error[data-code="CONFIRMED_DOMESTIC"]');
  await expect(error).toContainText('不属于境外金融活动');
  await expect(page).toHaveURL(/\/transactions\/new$/);
  expect(creates.seen).toHaveLength(1); // a 4xx is never retried
  await shot(page, '73-create-confirmed-domestic');
  await pick('商户所在地', '未知');
  await save();
  await expectSaved();
  expect(creates.seen).toHaveLength(2);
  expect(creates.seen[1]!.key).not.toBe(creates.seen[0]!.key); // new content → new key
  await creates.off();
  await expect(page.locator('.txn-snapshot [data-field="foreignStatus"]')).toHaveText('信息不足');
  expect(await countByQuery('Domestic Bookshop')).toBe(1);
});

/** A spend from the US wallet with a given merchant name, ready to submit. */
async function fillSimpleSpend(merchant: string) {
  await openForm();
  await field('商户').fill(merchant);
  await pick('商户所在地', '(US)');
  await pick('交易币种', 'USD');
  await field('商户交易金额').fill('7');
  await pick('扣款账户', CREATE_SEED.us);
  await pick('扣款账户 · 资金币种', 'USD', false);
  await field('实际扣款金额').fill('7');
}

test('a lost response is retried automatically with the same key and the same body: one transaction, the first result', async () => {
  const creates = interceptCreates((route, n) => (n === 1 ? commitThenDrop(route) : route.continue()));
  await creates.on();
  await fillSimpleSpend('Lost Response Cafe');
  await save();
  await expectSaved('这是此前那次提交的结果');
  await creates.off();
  expect(creates.seen).toHaveLength(2);
  expect(creates.seen[1]!.key).toBe(creates.seen[0]!.key);
  expect(creates.seen[1]!.body).toBe(creates.seen[0]!.body);
  expect(creates.seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(await countByQuery('Lost Response Cafe')).toBe(1);
  expect(await storedKeys()).toEqual([]);
});

test('after the automatic retries the form is locked; a reload restores the request; a manual retry saves it once', async () => {
  const creates = interceptCreates((route) => commitThenDrop(route));
  await creates.on();
  await fillSimpleSpend('Unconfirmed Cafe');
  await save();
  // While the automatic retries are pending there is no manual retry or abandon (they cannot race it).
  await expect(banner()).toHaveAttribute('data-state', 'retrying');
  await expect(banner()).toContainText('正在用同一请求自动重试');
  await expect(page.locator('.txn-abandon')).toHaveCount(0);
  await expect(page.locator('.txn-retry')).toHaveCount(0);
  await expect(banner()).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await expect(banner()).toContainText('提交结果未确认');
  await expect(banner()).toContainText('已尝试 3 次');
  expect(creates.seen).toHaveLength(3);
  expect(new Set(creates.seen.map((s) => s.key)).size).toBe(1);
  expect(new Set(creates.seen.map((s) => s.body)).size).toBe(1);
  await expect(field('商户')).toBeDisabled();
  await expect(page.locator('.txn-submit')).toBeDisabled();
  // Every control of a locked form, not just some: nothing can change the request.
  await expect(form().locator('input:not([disabled]), textarea:not([disabled]), button:not([disabled]):not(.txn-cancel)')).toHaveCount(0);
  expect(await storedKeys()).toHaveLength(1);
  await shot(page, '74-create-unknown-locked');

  await page.reload();
  await expect(banner()).toContainText('页面刷新前的一次提交结果未确认');
  await expect(field('商户')).toHaveValue('Unconfirmed Cafe');
  await expect(field('实际扣款金额')).toHaveValue('7.00'); // rebuilt from the saved minor units
  await expect(form().locator('input:not([disabled]), textarea:not([disabled]), button:not([disabled]):not(.txn-cancel)')).toHaveCount(0);
  // The list points to it too.
  await page.goto('/transactions');
  await expect(page.locator('.txn-unresolved')).toContainText('提交结果未确认');
  await page.locator('.txn-unresolved').getByRole('button', { name: '去处理' }).click();
  await expect(banner()).toBeVisible();

  await creates.off();
  const after = interceptCreates((route) => route.continue());
  await after.on();
  await page.locator('.txn-retry').click();
  await expectSaved('这是此前那次提交的结果');
  await after.off();
  expect(after.seen).toHaveLength(1);
  expect(after.seen[0]!.key).toBe(creates.seen[0]!.key);
  expect(after.seen[0]!.body).toBe(creates.seen[0]!.body);
  expect(await countByQuery('Unconfirmed Cafe')).toBe(1);
  expect(await storedKeys()).toEqual([]);
});

test('a request still in flight when the page goes away is restored as unknown (pagehide) and sent again with its key', async () => {
  let held: Route | null = null;
  const creates = interceptCreates(async (route) => {
    held = route; // never answered: the page leaves first
  });
  await creates.on();
  await fillSimpleSpend('In Flight Cafe');
  await save();
  await expect(banner()).toHaveAttribute('data-state', 'sending');
  await expect.poll(() => creates.seen.length).toBe(1);
  await page.reload(); // beforeunload asks (accepted by the journey), pagehide stores the request
  await expect(banner()).toContainText('页面刷新前的一次提交结果未确认');
  await creates.off();
  await (held as Route | null)?.abort().catch(() => {});
  const after = interceptCreates((route) => route.continue());
  await after.on();
  await page.locator('.txn-retry').click();
  await expectSaved(); // it never reached the server: a normal first save
  await after.off();
  expect(after.seen[0]!.key).toBe(creates.seen[0]!.key);
  expect(await countByQuery('In Flight Cafe')).toBe(1);
});

test('abandoning an unknown request warns to check the list first; then the form is free and a new submit uses a new key', async () => {
  const creates = interceptCreates((route) => route.abort('failed')); // never reaches the server
  await creates.on();
  await fillSimpleSpend('Abandoned Cafe');
  await save();
  await expect(banner()).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await page.locator('.txn-abandon').click();
  const confirm = page.locator('.txn-abandon-confirm');
  await expect(confirm).toContainText('这笔交易可能已经保存');
  await expect(confirm).toContainText('先在流水列表中检查');
  await expect(confirm.locator('.txn-check-list')).toHaveAttribute('href', '/transactions');
  await expect(confirm.locator('.txn-check-list')).toHaveAttribute('target', '_blank');
  await shot(page, '76-create-abandon-confirm');
  await confirm.getByRole('button', { name: btn('放弃') }).click();
  await expect(banner()).toHaveCount(0);
  await expect(field('商户')).toBeEnabled();
  expect(await storedKeys()).toEqual([]);
  expect(await countByQuery('Abandoned Cafe')).toBe(0);
  await creates.off();

  const after = interceptCreates((route) => route.continue());
  await after.on();
  await save();
  await expectSaved();
  await after.off();
  expect(after.seen[0]!.key).not.toBe(creates.seen[0]!.key);
  expect(await countByQuery('Abandoned Cafe')).toBe(1);
});

test('phone layout: the form fits and saves', async ({ browser }) => {
  const phone = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await phone.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto('/transactions/new?type=third_party_transfer');
    await expect(p.locator('.txn-form')).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const pickOn = async (label: string, option: string | RegExp, type = true) => {
      const input = p.getByLabel(label, { exact: true });
      await input.click();
      if (type && typeof option === 'string') await input.pressSequentially(option);
      await p.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).first().click();
    };
    await p.locator('.txn-form').getByText('汇入（他人汇来）', { exact: true }).click();
    await pickOn('收款账户', CREATE_SEED.us);
    await pickOn('收款账户 · 资金币种', 'USD', false);
    await p.getByLabel('实际到账金额', { exact: true }).fill('12');
    await p.locator('.txn-form').getByText('对方金额未知', { exact: true }).click();
    await p.getByLabel('对手方名称', { exact: true }).fill('Phone Sender');
    await pickOn('对方账户法域', /^未知$/, false);
    await shot(p, '75-create-phone');
    await p.locator('.txn-submit').click();
    await expect(p).toHaveURL(/\/transactions\/[0-9a-z]{26}$/);
    await expect(p.locator('.txn-head')).toContainText('第三方汇款 · 汇入');
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }
});

test('signing out clears a stored unknown request', async () => {
  const creates = interceptCreates((route) => route.abort('failed'));
  await creates.on();
  await fillSimpleSpend('Signed Out Cafe');
  await save();
  await expect(banner()).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  expect(await storedKeys()).toHaveLength(1);
  await creates.off();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await storedKeys()).toEqual([]);
});

test('no console errors', async () => {
  expect(consoleErrors).toEqual([]);
});

export type { Locator };
