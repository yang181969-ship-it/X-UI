import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { totp, TXN_SEED, TXN_TOTP_SECRET, TXN_USER } from './fixtures.ts';

/**
 * M3-B4-B browser journey (read-only transaction views), as its own user. The transactions are
 * created through the real API (POST /api/transactions with an Idempotency-Key; one fact correction,
 * one void) because the create and lifecycle forms arrive in B4-C / B4-D. Then: the list (server
 * order, each amount in its own currency, no total), quick views, filters and search in the URL
 * across reloads, keyset "load more", the detail (saved snapshot apart from the current records),
 * the read-only version history, an account rename / jurisdiction change that leaves the snapshot
 * alone, notes on a voided transaction, delete protection on the account, currency, card and channel
 * pages, and the narrow (phone) layout.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("确 定").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

/** Dates relative to today (UTC), so occurredOn never passes the server's limit. */
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const ids = { hk: '', usd: '', cn: '', card: '', channel: '' };
const tx = { spend: '', pending: '', own: '', inbound: '', undetermined: '', voided: '' };

const rows = () => page.locator('.txn-table tbody tr.ant-table-row');
const rowIds = () => rows().evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-txn')));
const row = (id: string) => page.locator(`.txn-table tr[data-txn="${id}"]`);
const quick = (label: string) => page.locator('.txn-quick').getByText(label, { exact: true });
const confirmBox = () => page.locator('.ant-modal-confirm:visible');
/** Wait for a drawer's open transition before a screenshot. */
const settled = (drawer: Locator) => drawer.evaluate((el) => Promise.all((el.closest('.ant-drawer') ?? el).getAnimations({ subtree: true }).map((a) => a.finished)));

/** One API call from the signed-in page (same origin: cookie, Origin and CSRF header as the app sends them). */
async function call<T = unknown>(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; json: T }> {
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

let keySeq = 0;
const newKey = () => `e2e-b4b-${Date.now()}-${++keySeq}`.padEnd(20, '0');

async function create(body: Record<string, unknown>): Promise<string> {
  const r = await call<{ transactionId: string }>('POST', '/transactions', body, newKey());
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.transactionId;
}

/** Choose an option in the antd Select labelled `label` inside `scope`. */
async function pick(label: string, option: string | RegExp, scope: Locator = page.locator('body'), type = true) {
  const input = scope.getByLabel(label, { exact: true });
  await input.click();
  if (type && typeof option === 'string') await input.pressSequentially(option);
  const listId = await input.getAttribute('aria-controls');
  const popup = listId ? page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) }) : page.locator('.ant-select-dropdown:visible').last();
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

async function clearSelect(label: string, scope: Locator = page.locator('.txn-filter-row')) {
  const select = scope.locator('.ant-select').filter({ has: page.getByLabel(label, { exact: true }) });
  await select.hover();
  await select.locator('.ant-select-clear').click();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected HTTP errors the browser logs on its own: the anonymous /auth/me probe (401), the
    // malformed / missing version this journey opens on purpose (400 / 404), the in-use answers it
    // provokes (409) and the notes failure it simulates (500).
    if (/the server responded with a status of (400|401|404|409|500)/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in and records fictional transactions through the API', async () => {
  await page.goto('/transactions');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(TXN_USER.username);
  await page.getByPlaceholder('密码').fill(TXN_USER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(TXN_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  await expect(page.locator('.txn-list-card')).toContainText('还没有流水');

  const accounts = (await call<{ id: string; name: string }[]>('GET', '/accounts?status=all')).json;
  ids.hk = accounts.find((a) => a.name === TXN_SEED.hkAccount)!.id;
  ids.usd = accounts.find((a) => a.name === TXN_SEED.usdAccount)!.id;
  ids.cn = accounts.find((a) => a.name === TXN_SEED.cnAccount)!.id;
  ids.card = (await call<{ id: string }[]>('GET', '/cards?status=all')).json[0]!.id;
  ids.channel = (await call<{ id: string }[]>('GET', '/payment-channels?status=all')).json[0]!.id;

  const base = { recordMode: 'current', occurredTime: null, postedOn: null, paymentChannelId: null, cardId: null, transferMethod: null, notes: null };
  // A US merchant, paid with the card from the HKD account (USD 10.00 charged as HKD 78.30), then corrected to HKD 78.50.
  tx.spend = await create({
    ...base,
    type: 'merchant_spend',
    occurredOn: day(7),
    occurredTime: '14:05',
    eventCurrency: 'USD',
    eventAmount: 1000,
    merchantName: 'Contoso Cafe',
    merchantCountry: 'US',
    cardId: ids.card,
    counterparty: null,
    entries: [{ direction: 'out', accountId: ids.hk, currency: 'HKD', amountStatus: 'confirmed', amount: 7830 }],
  });
  const fix = await call(
    'POST',
    `/transactions/${tx.spend}/revisions`,
    {
      kind: 'fact_correction',
      baseRevision: 1,
      reason: '扣款金额录错',
      recordMode: 'current',
      occurredOn: day(7),
      occurredTime: '14:05',
      postedOn: null,
      eventCurrency: 'USD',
      eventAmount: 1000,
      merchantName: 'Contoso Cafe',
      merchantCountry: 'US',
      cardId: ids.card,
      paymentChannelId: null,
      transferMethod: null,
      counterparty: null,
      entries: [{ direction: 'out', accountId: ids.hk, currency: 'HKD', amountStatus: 'confirmed', amount: 7850 }],
    },
    newKey(),
  );
  expect(fix.status, JSON.stringify(fix.json)).toBe(201);
  // A JPY purchase through the wallet whose HKD charge is not known yet (pending, never estimated).
  tx.pending = await create({
    ...base,
    type: 'merchant_spend',
    occurredOn: day(6),
    eventCurrency: 'JPY',
    eventAmount: 1500,
    merchantName: 'Fabrikam Store',
    merchantCountry: 'JP',
    paymentChannelId: ids.channel,
    counterparty: null,
    entries: [{ direction: 'out', accountId: ids.hk, currency: 'HKD', amountStatus: 'pending', amount: null }],
  });
  // Own transfer between two registered accounts, across currencies: each side keeps its own amount.
  tx.own = await create({
    ...base,
    type: 'own_transfer',
    occurredOn: day(5),
    eventCurrency: 'HKD',
    eventAmount: 100000,
    merchantName: null,
    merchantCountry: null,
    transferMethod: 'swift',
    counterparty: null,
    notes: '季度调拨备忘',
    entries: [
      { direction: 'out', accountId: ids.hk, currency: 'HKD', amountStatus: 'confirmed', amount: 100000 },
      { direction: 'in', accountId: ids.usd, currency: 'USD', amountStatus: 'confirmed', amount: 12800 },
    ],
  });
  // Money received from a third party whose sent amount is unknown (P8).
  tx.inbound = await create({
    ...base,
    type: 'third_party_transfer',
    occurredOn: day(4),
    eventCurrency: null,
    eventAmount: null,
    merchantName: null,
    merchantCountry: null,
    counterparty: { name: 'Northwind Traders', country: null, institution: null, accountHint: null },
    entries: [{ direction: 'in', accountId: ids.usd, currency: 'USD', amountStatus: 'confirmed', amount: 5000 }],
  });
  // A home-region account at a merchant of unknown country: not enough information (not domestic).
  tx.undetermined = await create({
    ...base,
    type: 'merchant_spend',
    occurredOn: day(3),
    eventCurrency: 'CNY',
    eventAmount: 8800,
    merchantName: 'Tailspin Bookshop',
    merchantCountry: null,
    counterparty: null,
    entries: [{ direction: 'out', accountId: ids.cn, currency: 'CNY', amountStatus: 'confirmed', amount: 8800 }],
  });
  // A refund into the HKD account's EUR, then voided.
  tx.voided = await create({
    ...base,
    type: 'merchant_refund',
    occurredOn: day(8),
    eventCurrency: 'EUR',
    eventAmount: 2000,
    merchantName: 'Contoso Cafe',
    merchantCountry: 'US',
    counterparty: null,
    notes: 'refund note',
    entries: [{ direction: 'in', accountId: ids.hk, currency: 'EUR', amountStatus: 'confirmed', amount: 2000 }],
  });
  const voided = await call('POST', `/transactions/${tx.voided}/void`, { baseRevision: 1, reason: '重复记录' }, newKey());
  expect(voided.status).toBe(200);
});

test('lists current versions in the server order, each amount in its own currency, without totals', async () => {
  await page.reload();
  await expect(rows()).toHaveCount(5);
  await expect.poll(rowIds).toEqual([tx.undetermined, tx.inbound, tx.own, tx.pending, tx.spend]);

  // The cross-currency own transfer: two entries, each in its own currency — never added up.
  const own = row(tx.own);
  await expect(own).toContainText('本人调拨');
  await expect(own.locator('.txn-entry[data-currency="HKD"]')).toContainText('1,000.00');
  await expect(own.locator('.txn-entry[data-currency="HKD"]')).toContainText('流出');
  await expect(own.locator('.txn-entry[data-currency="USD"]')).toContainText('128.00');
  await expect(own.locator('.txn-entry[data-currency="USD"]')).toContainText('流入');
  await expect(own.locator('.txn-entry')).toHaveCount(2);

  await expect(row(tx.pending).locator('.txn-entry')).toContainText('HKD 待补录');
  await expect(row(tx.pending)).toContainText('JPY 1,500'); // exponent 0
  await expect(row(tx.pending).locator('[data-tag="pending"]')).toBeVisible();
  await expect(row(tx.spend)).toContainText('HKD 78.50');
  await expect(row(tx.spend)).toContainText('USD 10.00');
  await expect(row(tx.spend).locator('[data-tag="revised"]')).toHaveText('已更正 · v2');
  await expect(row(tx.inbound)).toContainText('第三方汇款 · 汇入');
  await expect(row(tx.inbound)).toContainText('对方金额未知');
  await expect(row(tx.undetermined).locator('[data-tag="foreign-undetermined"]')).toHaveText('信息不足');
  await expect(row(tx.spend).locator('[data-tag="foreign-foreign"]')).toHaveText('已确认境外');
  // The voided one is not in the default (active) list.
  await expect(row(tx.voided)).toHaveCount(0);

  // No total, balance, rate or count anywhere on the page.
  const text = await page.locator('.content-area').innerText();
  expect(text).not.toMatch(/余额|汇率|总计|合计[:：]|共\s*\d+\s*(条|笔)/);
  await expect(page.locator('.txn-list-foot')).toContainText('已全部加载');
  await shot(page, '60-transactions-list');
});

test('quick views and filters live in the URL and survive a reload', async () => {
  await quick('待补录').click();
  await expect(page).toHaveURL(/amountStatus=pending/);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.pending]);
  await page.reload();
  await expect.poll(rowIds).toEqual([tx.pending]);
  await expect(page.locator('.txn-quick .ant-segmented-item-selected')).toHaveText('待补录');

  await quick('已作废').click();
  await expect(page).toHaveURL(/status=voided/);
  await expect(rows()).toHaveCount(1);
  await expect(row(tx.voided)).toHaveClass(/is-voided/);
  await expect(row(tx.voided).locator('[data-tag="voided"]')).toHaveText('已作废');
  await quick('全部').click();
  await expect(rows()).toHaveCount(5);
  // Status "all" (by hand): the voided one too, and no quick view claims to be selected.
  await page.locator('.txn-filter-row .ant-segmented').getByText('全部', { exact: true }).click();
  await expect(page).toHaveURL(/status=all/);
  await expect(rows()).toHaveCount(6);
  await expect(page.locator('.txn-quick .ant-segmented-item-selected')).toHaveCount(0);
  await page.locator('.txn-filter-row .ant-segmented').getByText('有效', { exact: true }).click();
  await expect(rows()).toHaveCount(5);
  await expect(page.locator('.txn-quick .ant-segmented-item-selected')).toHaveText('全部');

  await pick('交易类型', '本人调拨', page.locator('.txn-filter-row'), false);
  await expect(page).toHaveURL(/type=own_transfer/);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.own]);
  await clearSelect('交易类型');
  await expect(rows()).toHaveCount(5);

  await pick('地域三态', '信息不足', page.locator('.txn-filter-row'), false);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.undetermined]);
  await clearSelect('地域三态');

  await pick('资金账户', TXN_SEED.usdAccount);
  await expect(page).toHaveURL(new RegExp(`accountId=${ids.usd}`));
  await expect(rows()).toHaveCount(2);
  await expect.poll(rowIds).toEqual([tx.inbound, tx.own]);
  await clearSelect('资金账户');

  await pick('银行卡', TXN_SEED.card);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.spend]);
  await clearSelect('银行卡');

  await pick('支付渠道', TXN_SEED.channel);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.pending]);
  await clearSelect('支付渠道');

  await pick('资金币种', 'USD');
  await expect(rows()).toHaveCount(2);
  await expect.poll(rowIds).toEqual([tx.inbound, tx.own]);
  await clearSelect('资金币种');

  await pick('记录方式', '历史补录', page.locator('.txn-filter-row'), false);
  await expect(page.locator('.txn-list-card')).toContainText('没有符合条件的流水');
  await clearSelect('记录方式');
  await expect(rows()).toHaveCount(5);

  // A date range from a link, restored after a reload and shown in the picker.
  await page.goto(`/transactions?from=${day(5)}&to=${day(4)}`);
  await expect(rows()).toHaveCount(2);
  await expect.poll(rowIds).toEqual([tx.inbound, tx.own]);
  await expect(page.getByPlaceholder('开始日期')).toHaveValue(day(5));
  await expect(page.getByPlaceholder('结束日期')).toHaveValue(day(4));
  await page.reload();
  await expect.poll(rowIds).toEqual([tx.inbound, tx.own]);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(rows()).toHaveCount(5);

  // Search (debounced) across merchant, counterparty and notes; normalized (case-insensitive).
  const search = page.getByLabel('搜索商户、对手方或备注', { exact: true });
  await search.fill('CONTOSO');
  await expect(page).toHaveURL(/q=CONTOSO/);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.spend]); // the voided Contoso refund stays out of the active list
  await page.reload();
  await expect(search).toHaveValue('CONTOSO');
  await expect.poll(rowIds).toEqual([tx.spend]);
  await search.fill('northwind');
  await expect(page).toHaveURL(/q=northwind/);
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.inbound]);
  await search.fill('季度调拨');
  await expect(rows()).toHaveCount(1);
  await expect.poll(rowIds).toEqual([tx.own]);
  await search.fill('');
  await expect(page).not.toHaveURL(/q=/);
  await expect(rows()).toHaveCount(5);
});

test('loads more pages with the server cursor and never shows a total count', async () => {
  await page.goto('/transactions?limit=2');
  await expect(rows()).toHaveCount(2);
  const more = page.getByRole('button', { name: '加载更多' });
  await more.click();
  await expect(rows()).toHaveCount(4);
  await more.click();
  await expect(rows()).toHaveCount(5);
  await expect(more).toHaveCount(0);
  await expect(page.locator('.txn-all-loaded')).toBeVisible();
  await expect.poll(rowIds).toEqual([tx.undetermined, tx.inbound, tx.own, tx.pending, tx.spend]);
  expect(await page.locator('.content-area').innerText()).not.toMatch(/共\s*\d+|\d+\s*条记录/);
});

test('the detail keeps the saved snapshot apart from the current records; history is read-only', async () => {
  await page.goto('/transactions?type=merchant_spend');
  await row(tx.spend).click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.spend}$`));
  const detail = page.locator('.txn-detail');
  await expect(detail.locator('.txn-head')).toContainText('商户消费');
  await expect(detail.locator('.txn-head')).toContainText('USD 10.00');
  await expect(detail.locator('.txn-head')).toContainText('当前版本 v2');

  const snapshot = detail.locator('.txn-snapshot');
  await expect(snapshot).toContainText('保存时快照 · 版本 v2');
  await expect(snapshot.locator('[data-field="merchantCountry"]')).toHaveText('美国 (US)');
  const entry = snapshot.locator('.txn-entry-table tbody tr.ant-table-row');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('HKD 78.50');
  await expect(entry.locator('[data-field="fundingAccountCountry"]')).toHaveText('香港 (HK)');
  await expect(entry).toContainText('沿用上一版本'); // same account in the fact correction: snapshot carried
  await expect(snapshot.locator('[data-field="homeRegion"]')).toHaveText('中国 (CN)');
  await expect(snapshot.locator('[data-field="foreignStatus"]')).toHaveText('已确认境外');

  const current = detail.locator('.txn-current');
  await expect(current).toContainText(TXN_SEED.hkAccount);
  await expect(current.locator('[data-field="currentAccountCountry"]')).toHaveText('香港 (HK)');
  await expect(current).toContainText(`${TXN_SEED.card} •••• ${TXN_SEED.cardLast4}`);
  await expect(current).toContainText('未使用支付渠道');

  const history = detail.locator('.txn-history');
  await expect(history.locator('.txn-revision-node')).toHaveCount(2);
  await expect(history.locator('[data-revision="1"]')).toContainText('v1 · 原始记录');
  await expect(history.locator('[data-revision="2"]')).toContainText('v2 · 事实更正');
  await expect(history.locator('[data-revision="2"]')).toContainText('原因：扣款金额录错');
  await expect(history.locator('[data-revision="2"]')).toContainText('当前');
  // Lifecycle actions (M3-B4-D) for an active transaction with nothing pending: fact / snapshot correction and void —
  // never a delete, never an edit of history.
  await expect(page.locator('.txn-actions .ant-btn')).toHaveCount(3);
  await expect(page.locator('.txn-action-settle')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0);
  await shot(page, '61-transaction-detail');

  // Version 1, read-only, in a drawer the URL opens directly.
  await history.getByRole('button', { name: '查看版本 v1' }).click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.spend}/revisions/1$`));
  const drawer = page.locator('.txn-revision-drawer');
  await expect(drawer).toContainText('版本 v1 · 原始记录');
  await expect(drawer).toContainText('只读');
  await expect(drawer).toContainText('该版本已被后续版本取代');
  await expect(drawer.locator('.txn-entry-table')).toContainText('HKD 78.30');
  await expect(drawer.locator('[data-field="fundingAccountCountry"]')).toHaveText('香港 (HK)');
  await expect(drawer.getByRole('button', { name: /作废|更正|删除|保存/ })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.txn-revision-drawer')).toContainText('版本 v1 · 原始记录');
  await expect(page.locator('.txn-revision-drawer .txn-entry-table')).toContainText('HKD 78.30');
  await settled(page.locator('.txn-revision-drawer'));
  await shot(page, '62-transaction-revision');
  await page.locator('.txn-revision-drawer .ant-drawer-close').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.spend}$`));
  await expect(page.locator('.txn-revision-drawer')).toBeHidden();

  // Malformed or unpublished versions: not found (400 / 404 from the API).
  await page.goto(`/transactions/${tx.spend}/revisions/abc`);
  await expect(page.locator('.txn-revision-drawer')).toContainText('该版本不存在');
  await page.goto(`/transactions/${tx.spend}/revisions/9`);
  await expect(page.locator('.txn-revision-drawer')).toContainText('该版本不存在');
  await page.goto('/transactions/no-such-transaction');
  await expect(page.locator('.content-area')).toContainText('交易不存在或已被删除');
});

test('back to the list keeps the filters it came from', async () => {
  await page.goto('/transactions?type=own_transfer');
  await row(tx.own).click();
  await expect(page.locator('.txn-snapshot .txn-entry-table tbody tr.ant-table-row')).toHaveCount(2);
  await expect(page.locator('.txn-snapshot')).toContainText('USD 128.00');
  await expect(page.locator('.txn-snapshot')).toContainText('HKD 1,000.00');
  await page.getByRole('link', { name: '返回流水列表' }).click();
  await expect(page).toHaveURL(/\/transactions\?type=own_transfer$/);
  await expect(rows()).toHaveCount(1);
});

test('renaming an account and changing its jurisdiction never changes the saved snapshot', async () => {
  const renamed = `${TXN_SEED.hkAccount}（新名称）`;
  const r = await call('PATCH', `/accounts/${ids.hk}`, { name: renamed, accountCountry: 'SG' });
  expect(r.status).toBe(200);
  await page.goto(`/transactions/${tx.spend}`);
  const current = page.locator('.txn-current');
  await expect(current).toContainText(renamed);
  await expect(current.locator('[data-field="currentAccountCountry"]')).toHaveText('新加坡 (SG)');
  const snapshot = page.locator('.txn-snapshot');
  await expect(snapshot.locator('.txn-entry-table')).toContainText(renamed); // the name is labelled current
  await expect(snapshot.locator('[data-field="fundingAccountCountry"]')).toHaveText('香港 (HK)');
  await expect(snapshot.locator('[data-field="foreignStatus"]')).toHaveText('已确认境外');
  await page.goto(`/transactions/${tx.spend}/revisions/1`);
  await expect(page.locator('.txn-revision-drawer [data-field="fundingAccountCountry"]')).toHaveText('香港 (HK)');
  await expect(page.locator('.txn-revision-drawer .txn-entry-table')).toContainText(renamed);
  await shot(page, '63-transaction-renamed-account');
});

test('notes on a voided transaction: save, blank, clear, and a failure keeps the text — no new version', async () => {
  await page.goto('/transactions?status=voided');
  await row(tx.voided).click();
  const detail = page.locator('.txn-detail');
  await expect(detail).toHaveAttribute('data-status', 'voided');
  await expect(detail.locator('.txn-void-node')).toContainText('已作废（终态）');
  await expect(detail.locator('.txn-void-node')).toContainText('作废原因：重复记录');
  await expect(detail.locator('.txn-head')).toContainText('当前版本 v1');
  const notes = page.locator('.txn-notes');
  await expect(notes.locator('.txn-notes-text')).toHaveText('refund note');

  await notes.getByRole('button', { name: '编辑备注' }).click();
  await notes.getByLabel('备注', { exact: true }).fill('作废后补充的说明');
  await notes.getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-message')).toContainText('备注已保存');
  await expect(notes.locator('.txn-notes-text')).toHaveText('作废后补充的说明');
  await page.reload();
  await expect(page.locator('.txn-notes .txn-notes-text')).toHaveText('作废后补充的说明');
  await expect(page.locator('.txn-head')).toContainText('当前版本 v1');
  await expect(page.locator('.txn-history .txn-revision-node')).toHaveCount(2); // v1 + the void node

  // A failed save keeps the editor and the typed text.
  await page.route('**/api/transactions/*/notes', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal error', code: 'INTERNAL' }) }));
  await notes.getByRole('button', { name: '编辑备注' }).click();
  await notes.getByLabel('备注', { exact: true }).fill('未保存的输入');
  await notes.getByRole('button', { name: btn('保存') }).click();
  await expect(notes.locator('.ant-alert-error')).toBeVisible();
  await expect(notes.getByLabel('备注', { exact: true })).toHaveValue('未保存的输入');
  await page.unroute('**/api/transactions/*/notes');

  // An empty box saves "" (not null).
  await notes.getByLabel('备注', { exact: true }).fill('');
  await notes.getByRole('button', { name: btn('保存') }).click();
  await expect(notes.locator('.txn-notes-text')).toHaveAttribute('data-notes', 'blank');
  expect((await call<{ notes: string | null }>('GET', `/transactions/${tx.voided}`)).json.notes).toBe('');
  // "Clear" saves null.
  await notes.getByRole('button', { name: '清除备注' }).click();
  await expect(notes.locator('.txn-notes-text')).toHaveAttribute('data-notes', 'null');
  await expect(notes.locator('.txn-notes-text')).toHaveText('无备注');
  const after = (await call<{ notes: string | null; currentRevision: number; status: string }>('GET', `/transactions/${tx.voided}`)).json;
  expect(after).toMatchObject({ notes: null, currentRevision: 1, status: 'voided' });
  await shot(page, '64-transaction-voided-notes');
});

test('delete protection names the transactions and offers close / deactivate / archive', async () => {
  // Account used by two transactions (and no channel): "used by 2 transactions", closing offered.
  await page.goto(`/accounts/${ids.usd}`);
  await page.locator('.account-head').getByRole('button', { name: '删除', exact: true }).click();
  await confirmBox().getByRole('button', { name: btn('删除') }).click();
  const accountInUse = confirmBox().filter({ hasText: '仍被引用' });
  await expect(accountInUse).toContainText('该账户被 2 笔流水引用（包括已作废的交易与历史版本）');
  await expect(accountInUse).toContainText('只能关闭该账户');
  await expect(accountInUse).not.toContainText('资金账户');
  await expect(accountInUse.getByRole('button', { name: btn('关闭账户') })).toBeVisible();
  await shot(page, '65-account-in-use-transactions');
  await accountInUse.getByRole('button', { name: btn('取消') }).click();
  await expect(page.locator('.account-head')).toContainText('正常');

  // A currency used only by a voided transaction's entry still can't be removed.
  await page.goto(`/accounts/${ids.hk}`);
  await page.getByRole('button', { name: '管理币种' }).click();
  const currencies = page.locator('.ant-modal:visible').last();
  await currencies.locator('.currency-row-edit[data-currency="EUR"]').getByRole('button', { name: '移除 EUR' }).click();
  await currencies.locator('.ant-modal-footer .ant-btn-primary').click();
  await expect(currencies.locator('.ant-alert')).toContainText('EUR 仍被银行卡关联或流水引用，不能移除');
  await currencies.getByRole('button', { name: btn('取消') }).click();

  // Card used by one transaction (both versions count once): deactivating offered.
  await page.goto(`/cards/${ids.card}`);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.card-delete-dialog .ant-modal-footer').getByRole('button', { name: btn('删除') }).click();
  const cardInUse = page.locator('.card-in-use:visible');
  await expect(cardInUse).toContainText(`「${TXN_SEED.card}」仍被引用，不能删除`);
  await expect(cardInUse).toContainText('该银行卡被 1 笔流水引用');
  await cardInUse.getByRole('button', { name: btn('停用') }).click();
  await expect(page.locator('.ant-message')).toContainText('已停用');

  // Channel used by one transaction: archiving offered.
  await page.goto(`/accounts/channels/${ids.channel}`);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.channel-delete-dialog').getByRole('button', { name: btn('删除') }).click();
  const channelInUse = page.locator('.channel-in-use:visible');
  await expect(channelInUse).toContainText(`「${TXN_SEED.channel}」仍被引用，不能删除`);
  await expect(channelInUse).toContainText('该支付渠道被 1 笔流水引用');
  await channelInUse.getByRole('button', { name: btn('归档') }).click();
  await expect(page.locator('.ant-message')).toContainText('已归档');

  // Everything is still there, and the transaction shows the current (deactivated / archived) states.
  await page.goto(`/transactions/${tx.pending}`);
  await expect(page.locator('.txn-current')).toContainText(TXN_SEED.channel);
  await expect(page.locator('.txn-current')).toContainText('已归档');
});

test('phone layout: cards instead of a table, filters in a drawer, detail and history readable', async ({ browser }) => {
  const phone = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await phone.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto('/transactions');
    await expect(p.locator('.txn-card')).toHaveCount(5);
    await expect(p.locator('.txn-table')).toHaveCount(0);
    await expect(p.locator(`.txn-card[data-txn="${tx.own}"] .txn-entry`)).toHaveCount(2);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await shot(p, '66-transactions-phone');

    await p.locator('.txn-filter-open').click();
    const drawer = p.locator('.txn-filter-drawer');
    await expect(drawer).toContainText('筛选流水');
    const typeInput = drawer.getByLabel('交易类型', { exact: true });
    await typeInput.click();
    await p.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '第三方汇款' }).click();
    await drawer.locator('.ant-drawer-close').click({ trial: true }); // not covered by the phone menu button
    await drawer.getByRole('button', { name: btn('完成') }).click();
    await expect(p).toHaveURL(/type=third_party_transfer/);
    await expect(p.locator('.txn-card')).toHaveCount(1);
    await expect(p.locator('.txn-filter-open')).toHaveText(/筛选（1）/);
    await p.reload();
    await expect(p.locator('.txn-card')).toHaveCount(1);

    await p.locator(`.txn-card[data-txn="${tx.inbound}"]`).click();
    await expect(p).toHaveURL(new RegExp(`/transactions/${tx.inbound}$`));
    await expect(p.locator('.txn-snapshot')).toContainText('USD 50.00');
    await expect(p.locator('.txn-snapshot [data-field="counterparty"]')).toContainText('Northwind Traders');
    await expect(p.locator('.txn-history .txn-revision-node')).toHaveCount(1);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await p.locator('.txn-history').getByRole('button', { name: '查看版本 v1' }).click();
    await expect(p.locator('.txn-revision-drawer')).toContainText('这是当前版本');
    await settled(p.locator('.txn-revision-drawer'));
    await shot(p, '67-transaction-phone-revision');
    await p.locator('.txn-revision-drawer .ant-drawer-close').click(); // not covered by the phone menu button
    await expect(p.locator('.txn-revision-drawer')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }
});

test('no console errors', async () => {
  expect(consoleErrors).toEqual([]);
});
