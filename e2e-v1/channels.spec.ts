import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { CHANNELS_SEED, CHANNELS_TOTP_SECRET, CHANNELS_USER, totp } from './fixtures.ts';

/**
 * M2-B5 browser journey through the real production build, as its own user: the 支付渠道 tab under
 * 账户 (no sixth top-level page) → create a payment service with a provider and a funds account
 * (taken accounts disabled, bank accounts and archived providers not offered) → duplicate name
 * refused → create a device wallet (no funds account, cards only) → add card sources, set and move
 * the default → end a source (history kept) → add it again and delete the mistaken record → the
 * card page links back → account sources and the funds account show on the account pages →
 * a device wallet can't take account sources → archive → filters → delete a channel (its source
 * records go, the cards stay) → another user's channel is not found → English → no balance, clean console.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("归 档").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
let walletUrl = '';
let serviceUrl = '';
const consoleErrors: string[] = [];

const dialog = (title: string) => page.locator('.ant-modal:visible').filter({ has: page.locator('.ant-modal-title', { hasText: title }) });
const confirmBox = () => page.locator('.ant-modal-confirm:visible');
const save = (m: Locator) => m.locator('.ant-modal-footer .ant-btn-primary').click();
const rows = () => page.locator('.channel-table tbody tr.clickable-row');
const row = (name: string) => rows().filter({ hasText: name });
const sources = () => page.locator('.channel-sources');
const sourceRow = (scope: Locator, name: string) => scope.locator('.source-row').filter({ has: page.locator('.row-title', { hasText: name }) });
const formItem = (scope: Locator, label: string) => scope.locator('.ant-form-item').filter({ has: page.locator('.ant-form-item-label', { hasText: label }) });

/** The dropdown of the antd Select labelled `label` inside `scope` (opened). */
async function openSelect(label: string, scope: Locator) {
  // By role: the source-type radio "银行卡" shares its name with the card select.
  const input = scope.getByRole('combobox', { name: label, exact: true });
  await input.click();
  const listId = await input.getAttribute('aria-controls');
  return { input, popup: listId ? page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) }) : page.locator('.ant-select-dropdown:visible').last() };
}

/** Choose an option in the antd Select labelled `label` inside `scope`. */
async function pick(label: string, option: string, scope: Locator, type = true) {
  const { input, popup } = await openSelect(label, scope);
  if (type) await input.pressSequentially(option);
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected: the anonymous /auth/me probe (401), the refused duplicate (409), the refused
    // device-wallet type change (400) and another user's channel (404).
    if (/the server responded with a status of (400|401|404|409)/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in; payment channels are a tab of 账户 (five top-level pages stay), listing the seeded channel', async () => {
  await page.goto('/accounts?tab=channels');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(CHANNELS_USER.username);
  await page.getByPlaceholder('密码').fill(CHANNELS_USER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(CHANNELS_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/accounts/);
  await page.goto('/accounts?tab=channels');
  await expect(page.locator('.ant-tabs-tab-active')).toHaveText('支付渠道');
  await expect(page.locator('.sider-nav .ant-menu-item')).toHaveCount(5);
  await expect(page.locator('.sider-nav .ant-menu-item-selected')).toContainText('账户');
  await expect(page.getByText('SWIFT、FPS、SEPA 等转账方式不是支付渠道')).toBeVisible();
  await expect(rows()).toHaveCount(1);
  await expect(row(CHANNELS_SEED.oldChannel)).toContainText(CHANNELS_SEED.takenFunds);
  await expect(row(CHANNELS_SEED.oldChannel)).toContainText('支付服务');
  await expect(row(CHANNELS_SEED.oldChannel)).toContainText('0 个有效来源');
});

test('creates a payment service: active providers only, e-money / stored-value funds accounts only, a taken one disabled', async () => {
  await page.getByRole('button', { name: '新建支付渠道' }).click();
  const m = dialog('新建支付渠道');
  await m.getByLabel('名称', { exact: true }).fill(CHANNELS_SEED.service);
  await expect(m.locator('.ant-radio-wrapper-checked')).toHaveText('支付服务');
  await expect(m).toContainText('如 PayPal：可关联银行卡或账户');
  // Providers: the archived institution is not offered.
  let s = await openSelect('服务机构', m);
  await expect(s.popup).toContainText(CHANNELS_SEED.provider);
  await expect(s.popup).not.toContainText(CHANNELS_SEED.archivedProvider);
  await page.keyboard.press('Escape');
  await pick('服务机构', CHANNELS_SEED.provider, m);
  // Funds accounts: e-money only (no bank account); the one already used by another channel is disabled.
  s = await openSelect('资金账户', m);
  await expect(s.popup).toContainText(CHANNELS_SEED.funds);
  await expect(s.popup).not.toContainText(CHANNELS_SEED.bankAccount);
  const taken = s.popup.locator('.ant-select-item-option').filter({ hasText: CHANNELS_SEED.takenFunds });
  await expect(taken).toHaveClass(/ant-select-item-option-disabled/);
  await expect(taken).toContainText(`已是「${CHANNELS_SEED.oldChannel}」的资金账户`);
  await page.keyboard.press('Escape');
  await pick('资金账户', CHANNELS_SEED.funds, m);
  await pick('注册地区', '(LU)', m);
  await expect(m).toContainText('仅用于展示，不用于判断资金所在地');
  await save(m);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(page.locator('.ant-message')).toContainText('支付渠道已创建');
  await expect(row(CHANNELS_SEED.service)).toContainText(CHANNELS_SEED.funds);
  await expect(row(CHANNELS_SEED.service)).toContainText(CHANNELS_SEED.provider);
  await expect(row(CHANNELS_SEED.service)).toContainText('卢森堡 (LU)');
  await shot(page, '50-channels-list');
});

test('a second channel with the same name (any case) is refused, offering the existing one', async () => {
  await page.getByRole('button', { name: '新建支付渠道' }).click();
  const m = dialog('新建支付渠道');
  await m.getByLabel('名称', { exact: true }).fill(` ${CHANNELS_SEED.service} `);
  await save(m);
  await expect(m.locator('.channel-duplicate')).toContainText('已存在同名的支付渠道');
  await expect(m.getByRole('button', { name: '查看已有渠道' })).toBeVisible();
  await m.locator('.ant-modal-footer .ant-btn').first().click();
  await expect(rows()).toHaveCount(2);
});

test('creates a device wallet: no funds account; its sources are cards only — add two, set and move the default', async () => {
  await page.getByRole('button', { name: '新建支付渠道' }).click();
  const m = dialog('新建支付渠道');
  await m.getByLabel('名称', { exact: true }).fill(CHANNELS_SEED.wallet);
  await m.locator('.ant-radio-wrapper').filter({ hasText: '设备钱包' }).click();
  await expect(m).toContainText('只能关联银行卡，不能直接关联账户');
  await expect(formItem(m, '资金账户')).toHaveCount(0);
  await save(m);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await row(CHANNELS_SEED.wallet).getByRole('link', { name: CHANNELS_SEED.wallet }).click();
  await expect(page).toHaveURL(/\/accounts\/channels\/[0-9a-z]{26}$/);
  walletUrl = page.url();
  await expect(page.locator('.channel-info')).toContainText('无');
  await expect(page.getByText('支付渠道不持有资金')).toBeVisible();
  await expect(sources()).toContainText('还没有资金来源');

  await sources().getByRole('button', { name: '添加资金来源' }).click();
  let a = dialog('添加资金来源');
  await expect(a).toContainText('设备钱包只能关联银行卡');
  await expect(a.locator('.ant-radio-wrapper').filter({ hasText: '账户' })).toHaveClass(/ant-radio-wrapper-disabled/);
  await pick('银行卡', CHANNELS_SEED.card, a);
  await a.getByLabel('设为该渠道的默认来源').check();
  await save(a);
  await expect(page.locator('.ant-message')).toContainText('资金来源已添加');
  const first = sourceRow(sources().locator('.source-current'), CHANNELS_SEED.card);
  await expect(first).toContainText(`•••• ${CHANNELS_SEED.cardLast4}`);
  await expect(first.locator('.link-tags')).toContainText('默认');

  await sources().getByRole('button', { name: '添加资金来源' }).click();
  a = dialog('添加资金来源');
  // A card that is already an active source is listed but disabled.
  const s = await openSelect('银行卡', a);
  await expect(s.popup.locator('.ant-select-item-option').filter({ hasText: CHANNELS_SEED.card })).toHaveClass(/ant-select-item-option-disabled/);
  await page.keyboard.press('Escape');
  await pick('银行卡', CHANNELS_SEED.virtualCard, a);
  await expect(a).toContainText(`当前默认来源为「${CHANNELS_SEED.card} •••• ${CHANNELS_SEED.cardLast4}」`);
  await save(a);
  const second = sourceRow(sources(), CHANNELS_SEED.virtualCard);
  await expect(second.locator('.link-tags')).not.toContainText('默认');
  await second.getByRole('button', { name: '设为默认' }).click();
  await expect(page.locator('.ant-message')).toContainText('已设为默认来源，原默认来源已取消');
  await expect(second.locator('.link-tags')).toContainText('默认');
  await expect(first.locator('.link-tags')).not.toContainText('默认');
  await expect(sources().locator('.link-tags', { hasText: '默认' })).toHaveCount(1);
});

test('ending a source keeps it as history (default cleared); re-adding is a new record; deleting a mistaken record removes it', async () => {
  const current = sources().locator('.source-current');
  await sourceRow(current, CHANNELS_SEED.virtualCard).getByRole('button', { name: '结束来源' }).click();
  await expect(confirmBox()).toContainText('保留为历史记录');
  await confirmBox().getByRole('button', { name: '结束来源' }).click();
  await expect(page.locator('.ant-message')).toContainText('来源已结束，历史已保留');
  const history = sources().locator('.source-history');
  const ended = sourceRow(history, CHANNELS_SEED.virtualCard);
  await expect(ended).toHaveAttribute('data-status', 'ended');
  await expect(ended.locator('.link-tags')).toContainText('已结束');
  await expect(ended.locator('.link-tags')).not.toContainText('默认');
  await expect(ended.getByRole('button', { name: '设为默认' })).toHaveCount(0);
  await expect(ended.getByRole('button', { name: '结束来源' })).toHaveCount(0);
  await expect(ended.getByRole('button', { name: '编辑备注' })).toBeVisible();
  await expect(history).toContainText('不能恢复');
  // No default is left on the channel; the remaining card can take it again.
  await expect(sources().locator('.link-tags', { hasText: '默认' })).toHaveCount(0);
  await expect(page.locator('.ant-modal:visible, .ant-modal-confirm:visible')).toHaveCount(0);
  await shot(page, '51-channel-sources-history');

  // Notes stay editable on an ended source.
  await ended.getByRole('button', { name: '编辑备注' }).click();
  const n = dialog('编辑备注');
  await n.getByLabel('备注', { exact: true }).fill('旧卡已换新');
  await save(n);
  await expect(ended).toContainText('旧卡已换新');

  // Added again by mistake (a new record, allowed after ending), then deleted as a correction.
  await sources().getByRole('button', { name: '添加资金来源' }).click();
  const a = dialog('添加资金来源');
  await pick('银行卡', CHANNELS_SEED.virtualCard, a);
  await save(a);
  await expect(current.locator('.source-row')).toHaveCount(2);
  await sourceRow(current, CHANNELS_SEED.virtualCard).getByRole('button', { name: '删除记录' }).click();
  await expect(confirmBox()).toContainText('仅用于纠正误录');
  await confirmBox().getByRole('button', { name: '删除记录' }).click();
  await expect(current.locator('.source-row')).toHaveCount(1);
  await expect(history.locator('.source-row')).toHaveCount(1);
});

test('the card page lists the channel and links back to it', async () => {
  await sourceRow(sources(), CHANNELS_SEED.card).getByRole('link', { name: CHANNELS_SEED.card }).click();
  await expect(page).toHaveURL(/\/cards\/[0-9a-z]{26}$/);
  const channels = page.locator('.card-channels');
  await expect(channels).toContainText(CHANNELS_SEED.wallet);
  await expect(channels).toContainText('设备钱包');
  await channels.getByRole('link', { name: CHANNELS_SEED.wallet }).click();
  await expect(page).toHaveURL(walletUrl);
});

test('the payment service takes a card and an account; both account pages show the channel', async () => {
  await page.goto('/accounts?tab=channels');
  await row(CHANNELS_SEED.service).click();
  await expect(page).toHaveURL(/\/accounts\/channels\/[0-9a-z]{26}$/);
  serviceUrl = page.url();
  await expect(page.locator('.channel-info')).toContainText(CHANNELS_SEED.funds);
  await expect(page.locator('.channel-info')).toContainText(CHANNELS_SEED.provider);
  await sources().getByRole('button', { name: '添加资金来源' }).click();
  let a = dialog('添加资金来源');
  await a.locator('.ant-radio-wrapper').filter({ hasText: '账户' }).click();
  await pick('账户', CHANNELS_SEED.bankAccount, a);
  await a.getByLabel('备注', { exact: true }).fill('绑定的银行账户');
  await save(a);
  const acc = sourceRow(sources(), CHANNELS_SEED.bankAccount);
  await expect(acc).toContainText('账户所属法域: 新加坡 (SG)');
  await expect(acc).toContainText('绑定的银行账户');
  await sources().getByRole('button', { name: '添加资金来源' }).click();
  a = dialog('添加资金来源');
  await pick('银行卡', CHANNELS_SEED.card, a);
  await a.getByLabel('设为该渠道的默认来源').check();
  await save(a);
  await expect(sourceRow(sources(), CHANNELS_SEED.card).locator('.link-tags')).toContainText('默认');
  await expect(page.locator('.ant-modal:visible, .ant-modal-confirm:visible')).toHaveCount(0);
  await shot(page, '52-channel-service');

  await acc.getByRole('link', { name: CHANNELS_SEED.bankAccount }).click();
  await expect(page.locator('.account-channels')).toContainText(`作为支付渠道的资金来源 (1)`);
  await expect(page.locator('.account-channels')).toContainText(CHANNELS_SEED.service);
  await page.goto(serviceUrl);
  await page.locator('.channel-info').getByRole('link', { name: CHANNELS_SEED.funds }).click();
  await expect(page.locator('.account-channels')).toContainText('用作支付渠道的资金账户 (1)');
  await page.locator('.account-channels').getByRole('link', { name: CHANNELS_SEED.service }).click();
  await expect(page).toHaveURL(serviceUrl);
});

test('a channel with an account source cannot become a device wallet; archiving keeps its sources and hides it by default', async () => {
  await page.locator('.account-head').getByRole('button', { name: /编\s*辑\s*渠\s*道/ }).click();
  const m = dialog('编辑渠道');
  await m.locator('.ant-radio-wrapper').filter({ hasText: '设备钱包' }).click();
  // Warned before saving; the advice is a new channel — never deleting sources.
  const warning = m.locator('.channel-type-blocked');
  await expect(warning).toContainText('该渠道仍有 1 个有效的账户来源，因此不能改为设备钱包');
  await expect(warning).toContainText('请新建一个设备钱包渠道');
  await expect(warning).not.toContainText('删除');
  await save(m);
  await expect(formItem(m, '类型')).toContainText('请新建一个设备钱包渠道');
  await expect(formItem(m, '类型')).not.toContainText('删除');
  await m.locator('.ant-modal-footer .ant-btn').first().click();
  await expect(page.locator('.channel-detail').getByText('支付服务').first()).toBeVisible();

  await page.locator('.account-head').getByRole('button', { name: /归\s*档/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已归档，资金来源保持不变');
  await expect(page.locator('.account-head')).toContainText('已归档');
  await expect(sources().locator('.source-current .source-row')).toHaveCount(2);
  await page.goto('/accounts?tab=channels');
  await expect(row(CHANNELS_SEED.service)).toHaveCount(0);
  await page.locator('.filter-row .ant-segmented-item').filter({ hasText: '已归档' }).click();
  await expect(rows()).toHaveCount(1);
  await expect(row(CHANNELS_SEED.service)).toContainText('已归档');
  await row(CHANNELS_SEED.service).getByRole('button', { name: '恢复' }).click();
  await expect(page.locator('.ant-message')).toContainText('已恢复');
  await page.locator('.filter-row .ant-segmented-item').filter({ hasText: '全部' }).click();
  await expect(rows()).toHaveCount(3);
});

test('search and type filters', async () => {
  const filters = page.locator('.filter-row');
  await filters.getByLabel('搜索渠道或服务机构').fill('设备');
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText(CHANNELS_SEED.wallet);
  // The provider's name matches too.
  await filters.getByLabel('搜索渠道或服务机构').fill(CHANNELS_SEED.provider);
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText(CHANNELS_SEED.service);
  await filters.getByLabel('搜索渠道或服务机构').fill('');
  await pick('类型', '支付服务', filters, false);
  await expect(rows()).toHaveCount(2);
  await expect(rows().filter({ hasText: CHANNELS_SEED.wallet })).toHaveCount(0);
  await filters.locator('.ant-select-clear').click({ force: true });
  await expect(rows()).toHaveCount(3);
});

test('deleting a channel says what goes with it (its source records) and what stays; the cards stay', async () => {
  await row(CHANNELS_SEED.wallet).getByRole('button', { name: '删除' }).click();
  const box = page.locator('.channel-delete-dialog');
  await expect(box).toContainText(`删除支付渠道「${CHANNELS_SEED.wallet}」`);
  await expect(box.locator('.channel-delete-impact')).toHaveText('将一并删除它的 2 条资金来源记录（有效 1 条，已结束 1 条）。');
  await expect(box).toContainText('不会删除：银行卡、账户（包括它的资金账户）与服务机构');
  await box.getByRole('button', { name: btn('删除') }).click();
  await expect(page.locator('.ant-message')).toContainText('已删除');
  await expect(row(CHANNELS_SEED.wallet)).toHaveCount(0);
  await page.goto(walletUrl);
  await expect(page.getByText('该支付渠道不存在或已被删除')).toBeVisible();
  await page.goto('/cards');
  await page.locator('.card-tile').filter({ hasText: CHANNELS_SEED.card }).locator('.card-face').click();
  await expect(page.locator('.card-channels')).toContainText(CHANNELS_SEED.service);
  await expect(page.locator('.card-channels')).not.toContainText(CHANNELS_SEED.wallet);
});

test("another user's channel is not found and never listed", async () => {
  await page.goto(`/accounts/channels/${CHANNELS_SEED.otherUsersChannelId}`);
  await expect(page.getByText('该支付渠道不存在或已被删除')).toBeVisible();
  await expect(page.locator('#root')).not.toContainText(CHANNELS_SEED.otherUsersChannel);
  await page.goto('/accounts?tab=channels');
  await page.locator('.filter-row .ant-segmented-item').filter({ hasText: '全部' }).click();
  await expect(rows()).toHaveCount(2);
  await expect(page.locator('#root')).not.toContainText(CHANNELS_SEED.otherUsersChannel);
});

test('in English too; never a balance, an amount or a rate, and the console stays clean', async ({ browser }) => {
  for (const url of [serviceUrl, '/accounts?tab=channels']) {
    await page.goto(url);
    await expect(page.locator('.ant-card').first()).toBeVisible();
    await expect(page.locator('#root')).not.toContainText('余额');
    await expect(page.locator('#root')).not.toContainText(/合计|总额|总资产|≈|汇率：/);
  }
  const other = await browser.newContext({ storageState: await context.storageState(), locale: 'en-US' });
  await other.addInitScript(() => localStorage.setItem('xui-v1-lang', 'en'));
  const p = await other.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(serviceUrl);
  await expect(p.locator('.channel-sources')).toContainText('Funding sources');
  await expect(p.locator('.channel-sources')).toContainText('Current sources');
  await expect(p.locator('.channel-info')).toContainText('Funds account');
  await expect(p.getByText('A payment channel holds no money')).toBeVisible();
  await expect(p.locator('#root')).not.toContainText(/balance/i);
  await p.goto('/accounts?tab=channels');
  await expect(p.locator('.ant-tabs-tab-active')).toHaveText('Payment channels');
  await expect(p.getByText('Transfer methods such as SWIFT, FPS or SEPA are not payment channels')).toBeVisible();
  expect(errors).toEqual([]);
  await other.close();
  expect(consoleErrors).toEqual([]);
});
