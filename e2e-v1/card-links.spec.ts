import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { LINKS_SEED, LINKS_TOTP_SECRET, LINKS_USER, totp } from './fixtures.ts';

/**
 * M2-B4 browser journey through the real production build, as its own user: a card without links
 * (no recommendation) → link a multi-currency account from the card page (all currencies, default)
 * → a USD purchase needs a conversion (candidates only, no funding currency) → link a USD account
 * (USD scope) → exact match with the explanation → duplicate refused → the account page shows the
 * link and links another card → suspend / resume and freezing the account change the
 * recommendation, never the links → per-scope defaults → end a link (history on both sides) →
 * delete a mistaken record → English → no balance anywhere, clean console.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("暂 停").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
let cardUrl = '';
const consoleErrors: string[] = [];

const dialog = (title: string) => page.locator('.ant-modal:visible').filter({ has: page.locator('.ant-modal-title', { hasText: title }) });
const confirmBox = () => page.locator('.ant-modal-confirm:visible');
const save = (m: Locator) => m.locator('.ant-modal-footer .ant-btn-primary').click();
const cardLinks = () => page.locator('.card-links');
const accountLinks = () => page.locator('.account-links');
const linkRow = (scope: Locator, name: string) => scope.locator('.link-row').filter({ has: page.locator('.row-title', { hasText: name }) });
const preview = () => page.locator('.spending-preview');
const result = () => preview().locator('.spending-result');
const candidate = (name: string) => preview().locator('.spending-candidate').filter({ hasText: name });

/** Choose an option in the antd Select labelled `label` inside `scope`. */
async function pick(label: string, option: string, scope: Locator = page.locator('body'), type = true) {
  const input = scope.getByLabel(label, { exact: true });
  await input.click();
  if (type) await input.pressSequentially(option);
  const listId = await input.getAttribute('aria-controls');
  const popup = listId ? page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) }) : page.locator('.ant-select-dropdown:visible').last();
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

const previewCurrency = (code: string) => pick('消费币种', code, preview());

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // The anonymous /auth/me probe (401) and the 409 of the refused duplicate link are expected.
    if (/the server responded with a status of (401|409)/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in; a card without links gets no recommendation', async () => {
  await page.goto('/cards');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(LINKS_USER.username);
  await page.getByPlaceholder('密码').fill(LINKS_USER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(LINKS_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/cards$/);
  await page.locator('.card-tile').filter({ hasText: LINKS_SEED.card }).locator('.card-face').click();
  await expect(page).toHaveURL(/\/cards\/[0-9a-z]{26}$/);
  cardUrl = page.url();
  await expect(cardLinks()).toContainText('暂无关联账户');
  await expect(preview()).toContainText('不代表支付机构实际如何扣款');
  await expect(result()).toHaveAttribute('data-match', 'no_match');
  await expect(result()).toContainText('没有符合条件的消费资金来源');
});

test('links the multi-currency account from the card page (all currencies, default); a USD purchase needs a conversion', async () => {
  await cardLinks().getByRole('button', { name: '关联账户' }).click();
  const m = dialog('关联账户');
  // Only the user's own accounts are offered.
  const accountInput = m.getByLabel('账户', { exact: true });
  await accountInput.click();
  const listId = await accountInput.getAttribute('aria-controls');
  const popup = page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) });
  await expect(popup).toContainText(LINKS_SEED.usd);
  await expect(popup).not.toContainText(LINKS_SEED.otherUsersAccount);
  await page.keyboard.press('Escape');
  await pick('账户', LINKS_SEED.multi, m);
  // Scope: all currencies by default; the account's own currencies are offered.
  await expect(m.locator('.ant-form-item').filter({ has: page.locator('.ant-form-item-label', { hasText: '币种范围' }) })).toContainText('所有币种');
  await m.getByLabel('设为该币种范围内的默认消费资金来源').check();
  await save(m);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(page.locator('.ant-message')).toContainText('关联已建立');
  const row = linkRow(cardLinks(), LINKS_SEED.multi);
  await expect(row).toContainText('消费资金来源');
  await expect(row).toContainText('所有币种');
  await expect(row).toContainText('账户所属法域: 比利时 (BE)');
  await expect(row.locator('.link-tags')).toContainText('默认');

  await expect(result()).toHaveAttribute('data-match', 'conversion_required');
  await expect(result()).toContainText(`需要换汇：建议资金账户「${LINKS_SEED.multi}」，但它不持有有效的 USD`);
  await expect(result().locator('.spending-candidates .ant-tag')).toHaveText(['HKD', 'EUR']);
  // The account's default currency is a candidate, never the funding currency.
  await expect(result()).not.toContainText('以 HKD 扣款');
  await expect(result()).toContainText('不会默认为账户的默认币种');
  await shot(page, '40-link-conversion');
});

test('links the USD account with a USD scope: an exact match beats the default, and the explanation says why', async () => {
  await cardLinks().getByRole('button', { name: '关联账户' }).click();
  const m = dialog('关联账户');
  await pick('账户', LINKS_SEED.usd, m);
  await pick('币种范围', 'USD', m, false);
  await m.getByLabel('优先级', { exact: true }).fill('1');
  await save(m);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(linkRow(cardLinks(), LINKS_SEED.usd)).toContainText('优先级 1');

  await expect(result()).toHaveAttribute('data-match', 'exact_currency');
  await expect(result()).toContainText(`币种一致：建议从「${LINKS_SEED.usd}」以 USD 扣款`);
  await expect(preview().locator('.spending-candidate')).toHaveCount(2);
  await expect(preview().locator('.spending-candidate').first()).toContainText(LINKS_SEED.usd);
  await expect(candidate(LINKS_SEED.usd)).toContainText('推荐');
  await expect(candidate(LINKS_SEED.multi)).toContainText('需换汇（排序靠后）');
  await expect(preview()).toContainText('持有该消费币种的来源优先');
  // EUR: the multi-currency account holds it.
  await previewCurrency('EUR');
  await expect(result()).toContainText(`币种一致：建议从「${LINKS_SEED.multi}」以 EUR 扣款`);
  await previewCurrency('USD');
  await expect(result()).toHaveAttribute('data-match', 'exact_currency');
  await shot(page, '41-link-exact');
});

test('a second unfinished link with the same card, account, scope and role is refused', async () => {
  await cardLinks().getByRole('button', { name: '关联账户' }).click();
  const m = dialog('关联账户');
  await pick('账户', LINKS_SEED.multi, m);
  await save(m);
  await expect(m.locator('.link-duplicate')).toContainText('已存在相同银行卡、账户、币种范围与用途的未结束关联');
  await m.getByRole('button', { name: btn('取消') }).click();
  await expect(cardLinks().locator('.link-row')).toHaveCount(2);
});

test('the account page shows the same link, and links another card to the account', async () => {
  await cardLinks().getByRole('link', { name: LINKS_SEED.multi }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-z]{26}$/);
  const row = linkRow(accountLinks(), LINKS_SEED.card);
  await expect(row).toContainText(`•••• ${LINKS_SEED.cardLast4}`);
  await expect(row.locator('.link-tags')).toContainText('默认');
  await accountLinks().getByRole('button', { name: '关联银行卡' }).click();
  const m = dialog('关联银行卡');
  await pick('银行卡', LINKS_SEED.virtualCard, m);
  await m.locator('.ant-radio-wrapper').filter({ hasText: '充值来源' }).click();
  // Only spending sources can be defaults.
  await expect(m.getByLabel('设为该币种范围内的默认消费资金来源')).toBeDisabled();
  await save(m);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  // One account, several cards.
  await expect(accountLinks().locator('.link-current .link-row')).toHaveCount(2);
  await expect(linkRow(accountLinks(), LINKS_SEED.virtualCard)).toContainText('充值来源');
  await shot(page, '42-account-links');
});

test('suspend / resume and freezing the account change the recommendation, never the link', async () => {
  await page.goto(cardUrl);
  const usdRow = linkRow(cardLinks(), LINKS_SEED.usd);
  await usdRow.getByRole('button', { name: btn('暂停') }).click();
  await expect(usdRow.locator('.link-tags')).toContainText('暂停');
  await expect(result()).toHaveAttribute('data-match', 'conversion_required');
  await expect(candidate(LINKS_SEED.usd)).toContainText('跳过：关联已暂停');
  await usdRow.getByRole('button', { name: btn('恢复') }).click();
  await expect(usdRow.locator('.link-tags')).not.toContainText('暂停');
  await expect(result()).toHaveAttribute('data-match', 'exact_currency');

  // Freeze the USD account on its own page: the link stays, the recommendation skips it.
  await usdRow.getByRole('link', { name: LINKS_SEED.usd }).click();
  await page.locator('.account-head-actions').getByRole('button', { name: /(^|\s)冻\s*结$/ }).click();
  await expect(page.locator('.account-head')).toContainText('已冻结');
  await expect(linkRow(accountLinks(), LINKS_SEED.card)).toHaveAttribute('data-status', 'active');
  await page.goto(cardUrl);
  await expect(result()).toHaveAttribute('data-match', 'conversion_required');
  await expect(candidate(LINKS_SEED.usd)).toContainText('跳过：账户已冻结或已关闭');
  await expect(linkRow(cardLinks(), LINKS_SEED.usd).locator('.link-tags')).toContainText('已冻结');
  await linkRow(cardLinks(), LINKS_SEED.usd).getByRole('link', { name: LINKS_SEED.usd }).click();
  await page.locator('.account-head-actions').getByRole('button', { name: '解除冻结' }).click();
  await expect(page.locator('.account-head')).not.toContainText('已冻结');
  await page.goto(cardUrl);
  await expect(result()).toHaveAttribute('data-match', 'exact_currency');
});

test('defaults are per currency scope: the USD link becomes the USD default next to the all-currency default', async () => {
  const usdRow = linkRow(cardLinks(), LINKS_SEED.usd);
  await usdRow.getByRole('button', { name: '设为默认' }).click();
  await expect(usdRow.locator('.link-tags')).toContainText('默认');
  await expect(linkRow(cardLinks(), LINKS_SEED.multi).locator('.link-tags')).toContainText('默认');
  await expect(usdRow.getByRole('button', { name: '设为默认' })).toHaveCount(0);
});

test('ending a link keeps it as history on both sides; it is no longer considered', async () => {
  const row = linkRow(cardLinks(), LINKS_SEED.multi);
  await row.getByRole('button', { name: '解除关联' }).click();
  const m = page.locator('.link-end-dialog');
  await expect(m).toContainText('保留历史');
  await expect(m.getByLabel('结束日期')).not.toHaveValue('');
  await m.locator('.ant-modal-footer .ant-btn-primary').click();
  await expect(page.locator('.ant-message')).toContainText('已解除关联，历史已保留');
  const ended = linkRow(cardLinks().locator('.link-history'), LINKS_SEED.multi);
  await expect(ended).toHaveAttribute('data-status', 'ended');
  await expect(ended.locator('.link-tags')).toContainText('已结束');
  await expect(ended.locator('.link-tags')).not.toContainText('默认');
  // Ended is final: no suspend, resume, default or end any more.
  await expect(ended.getByRole('button', { name: btn('暂停') })).toHaveCount(0);
  await expect(ended.getByRole('button', { name: '解除关联' })).toHaveCount(0);
  await expect(ended.getByRole('button', { name: '编辑备注' })).toBeVisible();
  await expect(cardLinks().locator('.link-current .link-row')).toHaveCount(1);
  await previewCurrency('EUR');
  await expect(result()).toHaveAttribute('data-match', 'conversion_required');
  await expect(result()).toContainText(LINKS_SEED.usd);
  await expect(candidate(LINKS_SEED.multi)).toHaveCount(0);
  await shot(page, '43-link-history');

  await ended.getByRole('link', { name: LINKS_SEED.multi }).click();
  await expect(linkRow(accountLinks().locator('.link-history'), LINKS_SEED.card)).toContainText('已结束');
  await expect(linkRow(accountLinks().locator('.link-current'), LINKS_SEED.virtualCard)).toBeVisible();
});

test('deleting a mistaken record removes it (the card stays)', async () => {
  const row = linkRow(accountLinks(), LINKS_SEED.virtualCard);
  await row.getByRole('button', { name: '删除记录' }).click();
  await expect(confirmBox()).toContainText('仅用于纠正误录');
  await confirmBox().getByRole('button', { name: '删除记录' }).click();
  await expect(linkRow(accountLinks(), LINKS_SEED.virtualCard)).toHaveCount(0);
  await page.goto('/cards');
  await expect(page.locator('.card-tile').filter({ hasText: LINKS_SEED.virtualCard })).toBeVisible();
});

test('in English too; never a balance or a converted amount, and the console stays clean', async ({ browser }) => {
  await page.goto(cardUrl);
  await expect(preview()).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('余额');
  await expect(page.locator('#root')).not.toContainText(/合计|总额|总资产|≈|汇率：/);
  const other = await browser.newContext({ storageState: await context.storageState(), locale: 'en-US' });
  await other.addInitScript(() => localStorage.setItem('xui-v1-lang', 'en'));
  const p = await other.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(cardUrl);
  await expect(p.locator('.spending-preview')).toContainText('Funding source preview');
  await expect(p.locator('.card-links')).toContainText('Link history (ended)');
  await expect(p.locator('.spending-result')).toContainText('Same currency');
  expect(errors).toEqual([]);
  await other.close();
  expect(consoleErrors).toEqual([]);
});
