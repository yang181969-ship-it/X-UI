import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { LEDGER_SEED, RECOVER_TOTP_SECRET, RECOVER_USER } from './fixtures.ts';
import { accountIds, btn, call, commitThenDrop, create, factBody, getTxn, interceptWrites, newKey, noHorizontalScroll, pick, settled, signIn, spend, storedKeys } from './ledger-helpers.ts';

/**
 * M3-B4-D browser journey: lost responses and recovery of lifecycle writes (the B4-B/C pending-write
 * machine, one slot per operation and transaction), as its own user. The server commits and the
 * browser gets nothing (route.fetch + route.abort), or the request never reaches the server
 * (route.abort): automatic retries with the same key and bytes, a reload restoring the request (on
 * the correction page and from the detail page), manual retry, abandoning after a warning, sign-out
 * clearing it. Then the 390 px phone layout of every lifecycle screen.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
let acc: { hk: string; us: string; cn: string };
const tx: Record<string, string> = {};
const banner = (scope = page.locator('body')) => scope.locator('.txn-unknown');

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('dialog', (d) => void d.accept()); // beforeunload while a write is unconfirmed
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    if (/the server responded with a status of (401|409)|net::ERR_/.test(m.text())) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});
test.afterAll(async () => context.close());

const pendingSpend = (merchant: string) => spend({ merchant, country: 'US', currency: 'USD', amount: 1000, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: null } });
const confirmedSpend = (merchant: string, country: string | null = 'US') => spend({ merchant, country, currency: 'USD', amount: 1000, entry: { direction: 'out', accountId: acc.hk, currency: 'HKD', amount: 7830 } });

test('signs in and records fictional transactions through the API', async () => {
  await signIn(page, RECOVER_USER, RECOVER_TOTP_SECRET);
  acc = await accountIds(page);
  tx.settleLost = await create(page, pendingSpend('Settle Lost Cafe'));
  tx.voidLost = await create(page, confirmedSpend('Void Lost Cafe'));
  tx.factLost = await create(page, confirmedSpend('Fact Lost Cafe'));
  tx.settleKept = await create(page, pendingSpend('Settle Kept Cafe'));
  tx.voidAbandon = await create(page, confirmedSpend('Void Abandon Cafe'));
  tx.signOut = await create(page, confirmedSpend('Sign Out Cafe'));
  tx.phonePending = await create(page, pendingSpend('Phone Pending Cafe'));
  tx.phone = await create(page, confirmedSpend('Phone Cafe'));
});

test('a settlement whose response is lost: retried automatically with the same key and bytes; one new version', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/revisions', (route, n) => (n === 1 ? commitThenDrop(route) : route.continue()));
  await writes.on();
  await page.goto(`/transactions/${tx.settleLost}?action=settle`);
  const d = page.locator('.txn-settle-drawer');
  await d.getByLabel('补录金额 · out', { exact: true }).fill('78.30');
  await d.locator('.txn-submit').click();
  await expect(page.locator('.ant-message')).toContainText('这是此前那次提交的结果');
  await writes.off();
  expect(writes.seen).toHaveLength(2);
  expect(writes.seen[1]!.key).toBe(writes.seen[0]!.key);
  expect(writes.seen[1]!.body).toBe(writes.seen[0]!.body);
  const t = await getTxn(page, tx.settleLost);
  expect(t.currentRevision).toBe(2); // not 3
  expect(await storedKeys(page)).toEqual([]);
});

test('a void whose response is lost: retried, replayed; voided once, no new version', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/void', (route, n) => (n === 1 ? commitThenDrop(route) : route.continue()));
  await writes.on();
  await page.goto(`/transactions/${tx.voidLost}?action=void`);
  const modal = page.locator('.txn-void-modal');
  await modal.locator('.txn-void-confirm').click();
  await modal.locator('.txn-submit').click();
  await expect(page.locator('.txn-detail')).toHaveAttribute('data-status', 'voided');
  await writes.off();
  expect(writes.seen).toHaveLength(2);
  expect(writes.seen[1]!.key).toBe(writes.seen[0]!.key);
  expect((await getTxn(page, tx.voidLost))).toMatchObject({ status: 'voided', currentRevision: 1 });
});

test('a fact correction left unconfirmed: the form locks, a reload restores it on the correction page, a manual retry replays it', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/revisions', (route) => commitThenDrop(route));
  await writes.on();
  await page.goto(`/transactions/${tx.factLost}/correct`);
  await page.getByLabel('实际扣款金额', { exact: true }).fill('79.10');
  await page.getByLabel('更正原因', { exact: true }).fill('响应丢失测试');
  await page.locator('.txn-submit').click();
  await expect(banner()).toHaveAttribute('data-state', 'retrying');
  await expect(page.locator('.txn-retry, .txn-abandon')).toHaveCount(0);
  await expect(banner()).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  expect(writes.seen).toHaveLength(3);
  expect(new Set(writes.seen.map((s) => s.key)).size).toBe(1);
  await expect(page.locator('.txn-form').locator('input:not([disabled]), textarea:not([disabled]), button:not([disabled]):not(.txn-cancel)')).toHaveCount(0);
  const keys = await storedKeys(page);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toContain(`:transaction.correct:${tx.factLost}`); // one slot per operation and transaction
  await page.reload();
  await expect(banner()).toContainText('页面刷新前的一次提交结果未确认');
  await expect(page.getByLabel('实际扣款金额', { exact: true })).toHaveValue('79.10');
  await expect(page.getByLabel('更正原因', { exact: true })).toHaveValue('响应丢失测试');
  await shot(page, '86-fact-unknown-restored');
  await writes.off();
  const after = interceptWrites(page, '**/api/transactions/*/revisions', (route) => route.continue());
  await after.on();
  await page.locator('.txn-retry').click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${tx.factLost}$`));
  await expect(page.locator('.ant-message')).toContainText('这是此前那次提交的结果');
  await after.off();
  expect(after.seen[0]!.key).toBe(writes.seen[0]!.key);
  expect(after.seen[0]!.body).toBe(writes.seen[0]!.body);
  expect((await getTxn(page, tx.factLost)).currentRevision).toBe(2);
});

test('leaving with an unconfirmed settlement keeps it: the detail page offers to resolve it after a reload', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/revisions', (route) => route.abort('failed')); // never reaches the server
  await writes.on();
  await page.goto(`/transactions/${tx.settleKept}?action=settle`);
  const d = page.locator('.txn-settle-drawer');
  await d.getByLabel('补录金额 · out', { exact: true }).fill('55.20');
  await d.locator('.txn-submit').click();
  await expect(banner(d)).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await d.locator('.ant-drawer-close').click(); // leaving: the automatic retries are over; the request is kept
  await expect(page.locator('.txn-unresolved[data-target="settle"]')).toContainText('补录金额的提交结果未确认');
  await page.reload();
  await expect(page.locator('.txn-unresolved[data-target="settle"]')).toBeVisible();
  await writes.off();
  await page.locator('.txn-unresolved-open').click();
  await expect(banner(d)).toContainText('页面刷新前的一次提交结果未确认');
  await expect(d.getByLabel('补录金额 · out', { exact: true })).toHaveValue('55.20');
  await d.locator('.txn-retry').click();
  await expect(page.locator('.ant-message')).toContainText('已保存新版本'); // it never reached the server: a first save
  await expect(page.locator('.txn-unresolved')).toHaveCount(0);
  expect((await getTxn(page, tx.settleKept)).currentRevision).toBe(2);
});

test('abandoning an unconfirmed void: a warning first; nothing saved; a new void uses a new key', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/void', (route) => route.abort('failed'));
  await writes.on();
  await page.goto(`/transactions/${tx.voidAbandon}?action=void`);
  const modal = page.locator('.txn-void-modal');
  await modal.locator('.txn-void-confirm').click();
  await modal.locator('.txn-submit').click();
  await expect(banner(modal)).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await modal.locator('.txn-abandon').click();
  const confirm = page.locator('.txn-abandon-confirm');
  await expect(confirm).toContainText('先在流水列表中检查');
  await confirm.getByRole('button', { name: btn('放弃') }).click();
  await expect(banner(modal)).toHaveCount(0);
  expect(await storedKeys(page)).toEqual([]);
  expect((await getTxn(page, tx.voidAbandon)).status).toBe('active');
  await writes.off();
  const after = interceptWrites(page, '**/api/transactions/*/void', (route) => route.continue());
  await after.on();
  await modal.locator('.txn-submit').click();
  await expect(page.locator('.txn-detail')).toHaveAttribute('data-status', 'voided');
  await after.off();
  expect(after.seen[0]!.key).not.toBe(writes.seen[0]!.key);
});

test('phone (390 px): detail, settlement, fact correction, snapshot correction, void confirmation, conflict', async ({ browser }) => {
  const phone = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await phone.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    // Detail with its actions.
    await p.goto(`/transactions/${tx.phonePending}`);
    await expect(p.locator('.txn-actions .ant-btn')).toHaveCount(4);
    await noHorizontalScroll(p);
    for (const b of await p.locator('.txn-actions .ant-btn').all()) expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await shot(p, '87-phone-detail');

    // Settlement: a full-width drawer that closes.
    await p.locator('.txn-action-settle').click();
    const settle = p.locator('.txn-settle-drawer');
    await settled(settle);
    await noHorizontalScroll(p);
    // The close button is really clickable (not under the phone menu button): close, then reopen.
    await settle.locator('.ant-drawer-close').click();
    await expect(settle).toBeHidden();
    await p.locator('.txn-action-settle').click();
    await settled(settle);
    await settle.getByLabel('补录金额 · out', { exact: true }).fill('12.30');
    await shot(p, '88-phone-settle');
    await settle.locator('.txn-submit').click();
    await expect(p.locator('.txn-head')).toContainText('当前版本 v2');
    await expect(settle).toBeHidden();

    // Fact correction: the four types readable in full (B4-C follow-up), the form fits.
    await p.goto(`/transactions/${tx.phone}/correct`);
    await noHorizontalScroll(p);
    for (const label of await p.locator('.txn-type-switch .ant-segmented-item-label').all()) {
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expect(label).toBeInViewport();
    }
    await expect(p.locator('.txn-type-switch')).toContainText('第三方汇款');
    await shot(p, '89-phone-fact');
    await p.getByLabel('发生时间', { exact: true }).fill('10:20');
    await p.getByLabel('更正原因', { exact: true }).fill('手机端更正');
    await p.locator('.txn-submit').click();
    await expect(p).toHaveURL(new RegExp(`/transactions/${tx.phone}$`));
    await expect(p.locator('.txn-head')).toContainText('当前版本 v2');

    // Snapshot correction, both steps.
    await p.locator('.txn-action-snapshot').click();
    const snap = p.locator('.txn-snapshot-drawer');
    await pick(p, '新的账户法域（可选） · out', '(SG)', true, snap);
    await snap.getByLabel('更正原因', { exact: true }).fill('手机端快照更正');
    await snap.locator('.txn-next').click();
    await expect(snap.locator('[data-change="entry.out"]')).toContainText('新加坡 (SG)');
    await settled(snap);
    await noHorizontalScroll(p);
    await shot(p, '90-phone-snapshot');
    await expect(snap.locator('.ant-drawer-close')).toBeVisible();
    await snap.locator('.ant-drawer-close').click({ trial: true }); // clickable, nothing covers it
    await snap.locator('.txn-submit').click();
    await expect(p.locator('.txn-head')).toContainText('当前版本 v3');

    // Void confirmation with a conflict (someone corrected meanwhile), then recovery.
    await p.locator('.txn-action-void').click();
    const modal = p.locator('.txn-void-modal');
    await modal.locator('.txn-void-confirm').click();
    expect((await call(p, 'POST', `/transactions/${tx.phone}/revisions`, await factBody(p, tx.phone, (f) => (f.occurredTime = '11:45')), newKey())).status).toBe(201);
    await modal.locator('.txn-submit').click();
    await expect(modal.locator('.txn-conflict')).toContainText('当前是版本 v4');
    await settled(modal);
    await noHorizontalScroll(p);
    for (const b of await modal.locator('.ant-btn').all()) if (await b.isVisible()) expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await shot(p, '91-phone-void-conflict');
    await modal.locator('.ant-modal-close').click({ trial: true });
    await modal.locator('.txn-rebase').click();
    await modal.locator('.txn-void-confirm').click();
    await modal.locator('.txn-submit').click();
    await expect(p.locator('.txn-detail')).toHaveAttribute('data-status', 'voided');
    await expect(p.locator('.txn-head')).toContainText('当前版本 v4');
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }
});

test('signing out clears an unconfirmed lifecycle write', async () => {
  const writes = interceptWrites(page, '**/api/transactions/*/revisions', (route) => route.abort('failed'));
  await writes.on();
  await page.goto(`/transactions/${tx.signOut}?action=snapshot`);
  const d = page.locator('.txn-snapshot-drawer');
  await pick(page, '新的本国地区（可选）', '(SG)', true, d);
  await d.getByLabel('更正原因', { exact: true }).fill('退出登录测试');
  await d.locator('.txn-next').click();
  await d.locator('.txn-submit').click();
  await expect(banner(d)).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  expect(await storedKeys(page)).toHaveLength(1);
  await writes.off();
  await d.locator('.ant-drawer-close').click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await storedKeys(page)).toEqual([]);
});

test('no console errors', async () => {
  expect(consoleErrors).toEqual([]);
});

export { LEDGER_SEED };
