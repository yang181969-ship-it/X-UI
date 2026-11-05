import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { LEDGER_SEED, LIFE_TOTP_SECRET, LIFE_USER } from './fixtures.ts';
import { accountIds, btn, call, create, factBody, getTxn, interceptWrites, newKey, ownTransfer, pick, settled, signIn, spend } from './ledger-helpers.ts';

/**
 * M3-B4-D browser journey: lifecycle operations on existing transactions through the real UI and
 * API, as its own user. Settlement (one side, both sides, a closed currency carried over, nothing
 * left to settle), fact correction (reason and recordMode, a new account, no change refused, confirmed
 * domestic → void, version conflict keeping the draft), snapshot correction (old → new, the
 * classification preview, confirmed domestic refused by the server), void (explicit confirmation,
 * no new version, every version readable, no financial actions afterwards), and the void /
 * correction races (REVISION_CONFLICT, TRANSACTION_VOIDED).
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
let acc: { hk: string; us: string; cn: string };
const tx: Record<string, string> = {};

const detail = (id: string) => page.goto(`/transactions/${id}`);
const head = () => page.locator('.txn-head');
const drawer = (cls: string) => page.locator(`.${cls}`);
const message = () => page.locator('.ant-message');

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected: the anonymous /auth/me probe (401), refused corrections (400) and conflicts (409) the journey provokes.
    if (/the server responded with a status of (400|401|409)/.test(m.text())) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});
test.afterAll(async () => context.close());

test('signs in and records fictional transactions through the API', async () => {
  await signIn(page, LIFE_USER, LIFE_TOTP_SECRET);
  acc = await accountIds(page);
  tx.pendOne = await create(page, spend({ merchant: 'Pending One Cafe', country: 'US', currency: 'USD', amount: 1000, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: null } }));
  tx.pendTwo = await create(page, ownTransfer({ currency: 'HKD', amount: 100000, out: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: null }, in: { direction: 'in', accountId: acc.us, currency: 'USD', amount: null } }));
  tx.closed = await create(page, spend({ merchant: 'Closed Euro Shop', country: 'US', currency: 'USD', amount: 2000, recordMode: 'backfill', entry: { direction: 'out', accountId: acc.hk, currency: 'EUR', amount: null, ack: true } }));
  tx.fact = await create(page, spend({ merchant: 'Fact Cafe', country: 'US', currency: 'USD', amount: 1000, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: 7830 } }));
  tx.factBackfill = await create(page, spend({ merchant: 'Backfill Bistro', country: 'JP', currency: 'JPY', amount: 3000, recordMode: 'backfill', daysAgo: 40, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: 15800 } }));
  tx.domestic = await create(page, spend({ merchant: 'Maybe Domestic Books', country: null, currency: 'CNY', amount: 8800, entry: { direction: 'out', accountId: acc.cn, currency: 'CNY', amount: 8800 } }));
  tx.conflict = await create(page, spend({ merchant: 'Conflict Cafe', country: 'US', currency: 'USD', amount: 500, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: 3900 } }));
  tx.snap = await create(page, spend({ merchant: 'Snapshot Store', country: 'US', currency: 'USD', amount: 1200, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: 9400 } }));
  tx.snapDomestic = await create(page, spend({ merchant: 'Harbour Noodles', country: 'HK', currency: 'HKD', amount: 6800, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: 6800 } }));
  tx.void = await create(page, spend({ merchant: 'Void Me Store', country: 'US', currency: 'USD', amount: 500, entry: { direction: 'out', accountId: acc.us, currency: 'USD', amount: 500 } }));
  tx.raceVoid = await create(page, spend({ merchant: 'Race Void Cafe', country: 'US', currency: 'USD', amount: 100, entry: { direction: 'out', accountId: acc.us, currency: 'USD', amount: 100 } }));
  tx.raceSettle = await create(page, spend({ merchant: 'Race Settle Cafe', country: 'US', currency: 'USD', amount: 100, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: null } }));
});

test('settlement of a single pending entry: a new version, nothing left to settle', async () => {
  await detail(tx.pendOne);
  await page.locator('.txn-action-settle').click();
  await expect(page).toHaveURL(/action=settle/);
  const d = drawer('txn-settle-drawer');
  await expect(d.locator('.txn-settle-entry')).toHaveCount(1);
  await expect(d.locator('.txn-settle-entry')).toContainText(LEDGER_SEED.hk);
  await expect(d.locator('.txn-settle-entry')).toContainText('保存时状态：有效');
  await d.getByLabel('补录金额 · out', { exact: true }).fill('78.333');
  await d.locator('.txn-submit').click();
  await expect(d).toContainText('小数位数多于该币种允许的位数');
  await d.getByLabel('补录金额 · out', { exact: true }).fill('78.30');
  await settled(d);
  await shot(page, '80-settle-one');
  await d.locator('.txn-submit').click();
  await expect(message()).toContainText('已保存新版本');
  await expect(d).toBeHidden();
  await expect(head()).toContainText('当前版本 v2');
  await expect(page.locator('.txn-snapshot .txn-entry-table')).toContainText('HKD 78.30');
  await expect(page.locator('.txn-history [data-revision="2"]')).toContainText('v2 · 补录金额');
  await expect(page.locator('.txn-action-settle')).toHaveCount(0); // confirmed entries are never offered again
});

test('settlement of a two-sided own transfer: one side, then the other', async () => {
  await detail(tx.pendTwo);
  await page.locator('.txn-action-settle').click();
  const d = drawer('txn-settle-drawer');
  await expect(d.locator('.txn-settle-entry')).toHaveCount(2);
  await d.locator('.txn-settle-entry[data-direction="in"]').getByRole('checkbox').uncheck();
  await expect(d.getByLabel('补录金额 · in', { exact: true })).toBeDisabled();
  await d.getByLabel('补录金额 · out', { exact: true }).fill('1000');
  await d.locator('.txn-submit').click();
  await expect(head()).toContainText('当前版本 v2');
  const entries = page.locator('.txn-snapshot .txn-entry-table');
  await expect(entries.locator('tr[data-direction="out"]')).toContainText('HKD 1,000.00');
  await expect(entries.locator('tr[data-direction="in"]')).toContainText('USD 待补录');
  await page.locator('.txn-action-settle').click();
  await expect(d.locator('.txn-settle-entry')).toHaveCount(1);
  await expect(d.locator('.txn-settle-entry')).toHaveAttribute('data-direction', 'in');
  await d.getByLabel('补录金额 · in', { exact: true }).fill('128');
  await d.getByLabel('原因（可选）', { exact: true }).fill('到账通知');
  await d.locator('.txn-submit').click();
  await expect(head()).toContainText('当前版本 v3');
  await expect(entries.locator('tr[data-direction="in"]')).toContainText('USD 128.00');
  await expect(page.locator('.txn-history [data-revision="3"]')).toContainText('原因：到账通知');
});

test('settlement on a currency closed since: a lawful carry-over, no extra confirmation', async () => {
  await detail(tx.closed);
  await page.locator('.txn-action-settle').click();
  const d = drawer('txn-settle-drawer');
  await expect(d.locator('.txn-settle-entry')).toContainText('EUR');
  await expect(d.locator('.txn-settle-entry')).toContainText('保存时状态：已关闭');
  await expect(d).toContainText('无需另行确认');
  await expect(d.getByRole('checkbox')).toHaveCount(0);
  await d.getByLabel('补录金额 · out', { exact: true }).fill('18.40');
  await d.locator('.txn-submit').click();
  await expect(head()).toContainText('当前版本 v2');
  const snap = page.locator('.txn-snapshot');
  await expect(snap.locator('.txn-entry-table')).toContainText('EUR 18.40');
  await expect(snap.locator('[data-field="currencyStatusAtSave"]')).toHaveText('已关闭');
  await expect(snap).toContainText('沿用上一版本');
});

test('a confirmed entry is never settled again: no action, and the drawer says so', async () => {
  await detail(tx.fact);
  await expect(page.locator('.txn-action-settle')).toHaveCount(0);
  await page.goto(`/transactions/${tx.fact}?action=settle`);
  await expect(drawer('txn-settle-drawer')).toContainText('当前版本没有待补录的金额');
  await drawer('txn-settle-drawer').locator('.ant-drawer-close').click();
  await expect(page).not.toHaveURL(/action=/);
});

test('fact correction: same form, type fixed, reason required, no change refused, a new account saved', async () => {
  await detail(tx.fact);
  await page.locator('.txn-action-fact').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.fact}/correct$`));
  await expect(page.locator('.topbar')).toContainText('事实更正（基于版本 v1）');
  await expect(page.locator('.txn-type-switch')).toHaveClass(/ant-segmented-disabled/);
  await expect(page.locator('.txn-type-fixed')).toContainText('交易类型不能更改');
  await expect(page.locator('[data-field="homeRegionCarried"]')).toHaveText('中国 (CN)');
  await expect(page.getByLabel('商户', { exact: true })).toHaveValue('Fact Cafe');
  await expect(page.getByLabel('实际扣款金额', { exact: true })).toHaveValue('78.30');
  // Notes are not part of a correction.
  await expect(page.getByLabel('备注', { exact: true })).toHaveCount(0);
  await page.locator('.txn-submit').click();
  await expect(page.locator('.txn-reason-card')).toContainText('必填');
  await page.getByLabel('更正原因', { exact: true }).fill('确认没有变化');
  await page.locator('.txn-submit').click();
  await expect(page.locator('.txn-form-error[data-code="noChange"]')).toContainText('没有事实变化');
  await pick(page, '扣款账户', LEDGER_SEED.us);
  await pick(page, '扣款账户 · 资金币种', 'USD', false);
  await page.getByLabel('实际扣款金额', { exact: true }).fill('10');
  await page.getByLabel('更正原因', { exact: true }).fill('资金账户选错');
  await shot(page, '81-fact-correction');
  await page.locator('.txn-submit').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.fact}$`));
  await expect(message()).toContainText('已保存新版本');
  await expect(head()).toContainText('当前版本 v2');
  const entry = page.locator('.txn-snapshot .txn-entry-table tbody tr.ant-table-row');
  await expect(entry).toContainText(LEDGER_SEED.us);
  await expect(entry).toContainText('USD 10.00');
  await expect(entry.locator('[data-field="fundingAccountCountry"]')).toHaveText('美国 (US)');
  await expect(entry).toContainText('保存时的账户法域'); // a new account: its jurisdiction when saved
  await expect(page.locator('.txn-history [data-revision="2"]')).toContainText('原因：资金账户选错');
});

test('fact correction always sends recordMode: a backfill stays a backfill; same-account entries keep their snapshot', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/revisions', (route) => route.continue());
  await writes.on();
  await page.goto(`/transactions/${tx.factBackfill}/correct`);
  await expect(page.locator('.txn-form').getByRole('radio', { name: '历史补录' })).toBeChecked();
  await page.getByLabel('发生时间', { exact: true }).fill('09:30');
  await page.getByLabel('更正原因', { exact: true }).fill('补上时间');
  await page.locator('.txn-submit').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.factBackfill}$`));
  await writes.off();
  expect(writes.seen).toHaveLength(1);
  const body = JSON.parse(writes.seen[0]!.body!) as Record<string, unknown>;
  expect(body).toMatchObject({ kind: 'fact_correction', baseRevision: 1, recordMode: 'backfill', occurredTime: '09:30', reason: '补上时间' });
  expect(body).not.toHaveProperty('type');
  expect(body).not.toHaveProperty('notes');
  expect(body).not.toHaveProperty('declaredHomeRegion');
  const t = await getTxn(page, tx.factBackfill);
  expect(t.entries[0]).toMatchObject({ fundingAccountCountry: 'HK', countrySource: 'carried' });
  // The backfill reminder (B4-C follow-up) shows for an earlier date and changes nothing.
  await page.goto(`/transactions/${tx.factBackfill}/correct`);
  await expect(page.locator('.txn-hints [data-hint="backfill_past_date"]')).toContainText('早于今天');
});

test('a fact correction that would be confirmed domestic is refused by the server and leads to voiding', async () => {
  await page.goto(`/transactions/${tx.domestic}/correct`);
  await pick(page, '商户所在地', '(CN)');
  await page.getByLabel('更正原因', { exact: true }).fill('商户其实在境内');
  await page.locator('.txn-submit').click();
  const error = page.locator('.txn-form-error[data-code="CONFIRMED_DOMESTIC"]');
  await expect(error).toContainText('不属于境外金融活动');
  await expect(error).toContainText('应当作废');
  expect((await getTxn(page, tx.domestic)).currentRevision).toBe(1);
  await shot(page, '82-fact-domestic');
  await error.locator('.txn-void-instead').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.domestic}\\?action=void$`));
  const modal = page.locator('.txn-void-modal');
  await expect(modal).toContainText('作废是终态');
  await modal.locator('.txn-void-confirm').click();
  await modal.locator('.txn-submit').click();
  await expect(message()).toContainText('交易已作废');
  await expect(page.locator('.txn-detail')).toHaveAttribute('data-status', 'voided');
});

test('fact correction conflict: the draft is kept, the change is shown, the user rebases explicitly (new key)', async () => {
  await page.goto(`/transactions/${tx.conflict}/correct`);
  await page.getByLabel('实际扣款金额', { exact: true }).fill('40.50');
  await page.getByLabel('更正原因', { exact: true }).fill('我的更正');
  // Meanwhile another correction lands (another tab, another device).
  const other = await call(page, 'POST', `/transactions/${tx.conflict}/revisions`, await factBody(page, tx.conflict, (f) => (f.merchantName = 'Conflict Cafe Ltd')), newKey());
  expect(other.status).toBe(201);
  const writes = interceptWrites(page, '**/api/transactions/*/revisions', (route) => route.continue());
  await writes.on();
  await page.locator('.txn-submit').click();
  const panel = page.locator('.txn-conflict');
  await expect(panel).toContainText('你基于版本 v1，当前是版本 v2');
  await expect(panel.locator('[data-field="merchant"]')).toContainText('Conflict Cafe → Conflict Cafe Ltd');
  await expect(page.getByLabel('实际扣款金额', { exact: true })).toHaveValue('40.50'); // never overwritten
  await expect(page.getByLabel('更正原因', { exact: true })).toHaveValue('我的更正');
  await shot(page, '83-fact-conflict');
  expect((await getTxn(page, tx.conflict)).currentRevision).toBe(2);
  await panel.locator('.txn-rebase').click();
  await expect(page.locator('.topbar')).toContainText('基于版本 v2');
  await page.locator('.txn-submit').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.conflict}$`));
  await writes.off();
  expect(writes.seen).toHaveLength(2);
  expect(writes.seen[1]!.key).not.toBe(writes.seen[0]!.key); // baseRevision changed: a new request
  expect(JSON.parse(writes.seen[1]!.body!)).toMatchObject({ baseRevision: 2 });
  await expect(head()).toContainText('当前版本 v3');
});

test('snapshot correction: old → new values, the classification preview, then saved', async () => {
  await detail(tx.snap);
  await page.locator('.txn-action-snapshot').click();
  const d = drawer('txn-snapshot-drawer');
  await d.locator('.txn-next').click();
  await expect(d).toContainText('至少修改一项快照');
  await pick(page, '新的本国地区（可选）', '(HK)', true, d);
  await pick(page, '新的账户法域（可选） · out', '(SG)', true, d);
  await d.getByLabel('更正原因', { exact: true }).fill('当时的快照记录错误');
  await d.locator('.txn-next').click();
  await expect(d.locator('[data-step="confirm"]')).toBeVisible();
  await expect(d.locator('[data-change="homeRegion"]')).toContainText('中国 (CN) → 香港 (HK)');
  await expect(d.locator('[data-change="entry.out"]')).toContainText('香港 (HK) → 新加坡 (SG)');
  await expect(d).toContainText('预计结果');
  await expect(d).toContainText('以服务端保存的结果为准');
  await expect(d.locator('[data-preview="foreignStatus"]')).toContainText('已确认境外 → 已确认境外');
  await settled(d);
  await shot(page, '84-snapshot-confirm');
  await d.locator('.txn-submit').click();
  await expect(head()).toContainText('当前版本 v2');
  const snap = page.locator('.txn-snapshot');
  await expect(snap.locator('[data-field="homeRegion"]')).toHaveText('香港 (HK)');
  await expect(snap).toContainText('用户更正');
  await expect(snap.locator('[data-field="fundingAccountCountry"]')).toHaveText('新加坡 (SG)');
  await expect(page.locator('.txn-history [data-revision="2"]')).toContainText('v2 · 快照更正');
  // Amounts and currencies are unchanged.
  await expect(snap.locator('.txn-entry-table')).toContainText('HKD 94.00');
});

test('a snapshot correction to confirmed domestic: the preview warns, the server refuses, voiding is offered', async () => {
  await detail(tx.snapDomestic);
  await page.locator('.txn-action-snapshot').click();
  const d = drawer('txn-snapshot-drawer');
  await pick(page, '新的本国地区（可选）', '(HK)', true, d);
  await d.getByLabel('更正原因', { exact: true }).fill('当时住在香港');
  await d.locator('.txn-next').click();
  await expect(d.locator('[data-preview="foreignStatus"]')).toContainText('已确认境外 → 已确认境内');
  await expect(d.locator('.txn-preview-domestic')).toContainText('服务端将拒绝保存');
  await d.locator('.txn-submit').click();
  const error = d.locator('.txn-form-error[data-code="CONFIRMED_DOMESTIC"]');
  await expect(error).toContainText('不属于境外金融活动');
  expect((await getTxn(page, tx.snapDomestic)).currentRevision).toBe(1);
  await error.locator('.txn-void-instead').click();
  await expect(page).toHaveURL(/action=void/);
  await expect(page.locator('.txn-void-modal')).toBeVisible();
  await page.locator('.txn-void-modal .txn-cancel').click();
  await expect(page.locator('.txn-detail')).toHaveAttribute('data-status', 'active');
});

test('void: explicit confirmation; no new version; every version readable; no financial actions; notes still editable', async () => {
  await detail(tx.void);
  await page.locator('.txn-action-void').click();
  const modal = page.locator('.txn-void-modal');
  await expect(modal).toContainText('作废是终态：不能恢复，也不能永久删除');
  await expect(modal).toContainText('全部历史版本永久保留');
  await expect(modal.locator('.txn-submit')).toBeDisabled();
  await modal.getByLabel('作废原因', { exact: true }).fill('重复记录');
  await modal.locator('.txn-void-confirm').click();
  await settled(modal);
  await shot(page, '85-void-confirm');
  await modal.locator('.txn-submit').click();
  await expect(message()).toContainText('交易已作废');
  const d = page.locator('.txn-detail');
  await expect(d).toHaveAttribute('data-status', 'voided');
  await expect(head()).toContainText('当前版本 v1');
  await expect(page.locator('.txn-actions')).toHaveCount(0);
  await expect(page.locator('.txn-void-node')).toContainText('作废原因：重复记录');
  await expect(page.locator('.txn-notes').getByRole('button', { name: '编辑备注' })).toBeVisible();
  await page.locator('.txn-history').getByRole('button', { name: '查看版本 v1' }).click();
  await expect(page.locator('.txn-revision-drawer')).toContainText('这是当前版本');
  // The correction page refuses a voided transaction.
  await page.goto(`/transactions/${tx.void}/correct`);
  await expect(page.locator('.txn-voided-no-correction')).toContainText('已作废，不能再更正');
});

test('void vs correction race: the void gets REVISION_CONFLICT, the user rebases and confirms again', async () => {
  await detail(tx.raceVoid);
  await page.locator('.txn-action-void').click();
  const modal = page.locator('.txn-void-modal');
  await modal.locator('.txn-void-confirm').click();
  expect((await call(page, 'POST', `/transactions/${tx.raceVoid}/revisions`, await factBody(page, tx.raceVoid, (f) => (f.occurredTime = '08:15')), newKey())).status).toBe(201);
  await modal.locator('.txn-submit').click();
  const panel = modal.locator('.txn-conflict');
  await expect(panel).toContainText('你基于版本 v1，当前是版本 v2');
  await expect(panel.locator('[data-field="occurredTime"]')).toContainText('08:15');
  expect((await getTxn(page, tx.raceVoid)).status).toBe('active');
  await panel.locator('.txn-rebase').click();
  await expect(modal.locator('.txn-submit')).toBeDisabled(); // confirm again for the new version
  await modal.locator('.txn-void-confirm').click();
  await modal.locator('.txn-submit').click();
  await expect(page.locator('.txn-detail')).toHaveAttribute('data-status', 'voided');
  await expect(head()).toContainText('当前版本 v2');
});

test('settlement vs void race: TRANSACTION_VOIDED is final — the form closes, the detail refreshes, history stays', async () => {
  await detail(tx.raceSettle);
  await page.locator('.txn-action-settle').click();
  const d = drawer('txn-settle-drawer');
  await d.getByLabel('补录金额 · out', { exact: true }).fill('7.80');
  expect((await call(page, 'POST', `/transactions/${tx.raceSettle}/void`, { baseRevision: 1, reason: null }, newKey())).status).toBe(200);
  await d.locator('.txn-submit').click();
  await expect(message()).toContainText('交易已作废，不能再更正或作废');
  await expect(d).toBeHidden();
  await expect(page.locator('.txn-detail')).toHaveAttribute('data-status', 'voided');
  await expect(page.locator('.txn-actions')).toHaveCount(0);
  await expect(page.locator('.txn-history [data-revision="1"]')).toBeVisible();
  const t = await getTxn(page, tx.raceSettle);
  expect(t).toMatchObject({ status: 'voided', currentRevision: 1 });
  expect(t.entries[0]!.amountStatus).toBe('pending');
});

test('english labels for the lifecycle actions', async () => {
  await page.evaluate(() => localStorage.setItem('xui-v1-lang', 'en'));
  await detail(tx.snap);
  await expect(page.locator('.txn-actions')).toContainText('Correct facts');
  await expect(page.locator('.txn-actions')).toContainText('Correct snapshot');
  await expect(page.locator('.txn-actions')).toContainText('Void');
  await page.locator('.txn-action-void').click();
  await expect(page.locator('.txn-void-modal')).toContainText('Voiding is final');
  await page.locator('.txn-void-modal .txn-cancel').click();
  await page.evaluate(() => localStorage.setItem('xui-v1-lang', 'zh-CN'));
});

test('no console errors', async () => {
  expect(consoleErrors).toEqual([]);
});

export { btn };
