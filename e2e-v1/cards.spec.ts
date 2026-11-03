import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { CARDS_SEED, CARDS_TOTP_SECRET, CARDS_USER, totp } from './fixtures.ts';

/**
 * M2-B3 browser journey through the real production build, as its own user: card gallery with
 * expiry reminders → the form has no card-number field (four last-digit boxes, debit / prepaid
 * only, no pre-filled country) and refuses card numbers → create a debit card and a prepaid card
 * with its stored-value account → details (regions kept apart) and edit → filters, search, table
 * view → freeze / deactivate / restore → guarded delete of a linked card (accounts stay) → another
 * user's card unreachable → the same expiry answers in other time zones and in English → clean console.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("确 定").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

const NEW_CARD = 'Contoso Travel Debit';
const NEW_CARD_RENAMED = 'Contoso Travel Virtual';
const NEW_PREPAID = '示例新预付卡';
const NEW_ACCOUNT = '示例预付储值';
/** A full card number never appears on screen: four groups of four digits, or any 13+ digit run. */
const FULL_NUMBER = /\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}|\d{13,}/;

const dialog = (title: string | RegExp) => page.locator('.ant-modal:visible').filter({ has: page.locator('.ant-modal-title', { hasText: title }) });
const confirmBox = () => page.locator('.ant-modal-confirm:visible');
const tiles = () => page.locator('.card-tile');
const tile = (name: string) => tiles().filter({ has: page.locator('.card-tile-meta .row-title', { hasText: name }) });
const tileNames = () => page.locator('.card-tile .card-tile-meta .row-title');
const save = (m: Locator) => m.locator('.ant-modal-footer .ant-btn-primary').click();
/** The value cell next to a label in a bordered antd Descriptions. */
const field = (scope: Locator, label: string) => scope.locator('th.ant-descriptions-item-label', { hasText: label }).locator('xpath=following-sibling::td[1]');
const formItem = (m: Locator, label: string) => m.locator('.ant-form-item').filter({ has: page.locator('.ant-form-item-label', { hasText: label }) }).first();

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

async function clearSelect(label: string) {
  const select = page.locator('.filter-row .ant-select').filter({ has: page.getByLabel(label, { exact: true }) });
  await select.hover();
  await select.locator('.ant-select-clear').click();
}

async function typeLast4(form: Locator, digits: string) {
  await form.locator('.card-last4 input').first().click();
  await page.keyboard.type(digits);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected HTTP errors the browser logs on its own: the anonymous /auth/me probe (401) and the
    // page of a card that is gone or belongs to someone else (404).
    if (/the server responded with a status of (401|404)/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in and shows the card gallery with expiry reminders', async () => {
  await page.goto('/cards');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(CARDS_USER.username);
  await page.getByPlaceholder('密码').fill(CARDS_USER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(CARDS_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/cards$/);

  await expect(tileNames()).toHaveText([CARDS_SEED.linkedCard, CARDS_SEED.expiredCard, CARDS_SEED.longCard, CARDS_SEED.noExpiryCard, CARDS_SEED.archivedIssuerCard]);
  const linked = tile(CARDS_SEED.linkedCard);
  await expect(linked.locator('.card-face')).toContainText(`•••• ${CARDS_SEED.linkedLast4}`);
  await expect(linked.locator('.card-face')).toContainText(CARDS_SEED.bank);
  await expect(linked.locator('.card-face')).toContainText('VISA');
  await expect(linked.locator('.expiry-tag')).toHaveAttribute('data-expiry', 'expiring');
  await expect(linked).toContainText('1 个账户');
  await expect(tile(CARDS_SEED.expiredCard).locator('.expiry-tag')).toHaveAttribute('data-expiry', 'expired');
  // Expired is not a status: the card is still "正常".
  await expect(tile(CARDS_SEED.expiredCard).locator('.card-tile-tags')).toContainText('正常');
  await expect(tile(CARDS_SEED.longCard).locator('.expiry-tag')).toHaveAttribute('data-expiry', 'valid');
  await expect(tile(CARDS_SEED.noExpiryCard).locator('.expiry-tag')).toHaveAttribute('data-expiry', 'none');
  await expect(page.locator('[data-reminder="expiring"]')).toContainText('1 张卡片将在 60 天内到期');
  await expect(page.locator('[data-reminder="expired"]')).toContainText('1 张卡片已过期但仍未停用');
  // Another user's card is not listed; no full card number anywhere.
  await expect(page.getByText(CARDS_SEED.otherUsersCard)).toHaveCount(0);
  await expect(page.locator('#root')).not.toContainText(FULL_NUMBER);
  await shot(page, '30-cards-grid');
});

test('the form has no card-number field: four last-digit boxes, debit or prepaid only, nothing pre-filled', async () => {
  await page.getByRole('button', { name: '新建银行卡' }).click();
  const form = dialog(/^新建银行卡$/);
  await expect(form).toBeVisible();
  await expect(form).toContainText('没有卡号输入框');
  await expect(form.locator('.card-last4 input')).toHaveCount(4);
  await expect(form.locator('input[autocomplete^="cc-"]')).toHaveCount(0);
  await expect(form.getByText('卡号', { exact: true })).toHaveCount(0);
  await expect(formItem(form, '卡片类型').locator('.ant-radio-button-wrapper')).toHaveText(['借记卡', '预付卡']);
  await expect(formItem(form, '发卡国家/地区')).toContainText('选择国家/地区');

  // Saving an empty form is refused field by field.
  await save(form);
  for (const error of ['请选择发卡机构', '请输入卡片名称', '请选择卡组织', '请输入 4 位数字', '请选择发卡国家/地区']) await expect(form).toContainText(error);
  // Card numbers and security codes are refused; letters never reach the last-digit boxes.
  await form.getByLabel('卡片名称', { exact: true }).fill('Leaky 4111 1111 1111 1111');
  await form.getByLabel('备注', { exact: true }).fill('cvv 123');
  await typeLast4(form, 'ab12');
  await save(form);
  await expect(formItem(form, '卡片名称')).toContainText('疑似包含卡号或 CVV / PIN');
  await expect(formItem(form, '备注')).toContainText('疑似包含卡号或 CVV / PIN');
  await expect(formItem(form, '卡号后四位')).toContainText('请输入 4 位数字');
  await shot(page, '31-card-form-errors');
  await form.getByRole('button', { name: btn('取消') }).click();
  await expect(form).toBeHidden();
  await expect(tile('Leaky')).toHaveCount(0);
});

test('creates a virtual debit card', async () => {
  await page.getByRole('button', { name: '新建银行卡' }).click();
  const form = dialog(/^新建银行卡$/);
  await pick('发卡机构', CARDS_SEED.bank, form);
  await form.getByLabel('卡片名称', { exact: true }).fill(NEW_CARD);
  await form.locator('.ant-radio-button-wrapper', { hasText: '虚拟卡' }).click();
  await pick('卡组织', 'Visa', form, false);
  await typeLast4(form, '8642');
  await pick('发卡国家/地区', '(GB)', form);
  const expiry = form.getByLabel('有效期', { exact: true });
  await expiry.click();
  await expiry.fill('2029-05');
  await expiry.press('Enter');
  await shot(page, '32-card-form');
  await save(form);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  const created = tile(NEW_CARD);
  await expect(created.locator('.card-face')).toContainText('•••• 8642');
  await expect(created.locator('.card-face')).toContainText('05/29');
  await expect(created.locator('.card-face')).toContainText('虚拟卡');
  await expect(created.locator('.expiry-tag')).toContainText('有效至 2029-05');
  await expect(created.locator('.row-sub')).toHaveText('Visa · 借记卡 · 虚拟卡 · •••• 8642');
});

test('creates a prepaid card together with its stored-value account', async () => {
  await page.getByRole('button', { name: '新建银行卡' }).click();
  const form = dialog(/^新建银行卡$/);
  await pick('发卡机构', CARDS_SEED.emi, form);
  await form.getByLabel('卡片名称', { exact: true }).fill(NEW_PREPAID);
  await formItem(form, '卡片类型').locator('.ant-radio-button-wrapper', { hasText: '预付卡' }).click();
  await pick('卡组织', 'JCB', form, false);
  await typeLast4(form, '0042');
  await pick('发卡国家/地区', '(HK)', form);
  await form.getByText('同时创建储值账户').click();
  await form.getByLabel('储值账户名称', { exact: true }).fill(NEW_ACCOUNT);
  // The account jurisdiction is required and not taken from the card's issuing country.
  await save(form);
  await expect(form).toContainText('请选择账户所属法域');
  await pick('账户所属法域', '(HK)', form);
  await pick('币种', 'HKD', form);
  await save(form);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(page.locator('.ant-message')).toContainText('银行卡与储值账户已创建');
  await expect(tile(NEW_PREPAID)).toContainText('1 个账户');

  await tile(NEW_PREPAID).locator('.card-face').click();
  await expect(page).toHaveURL(/\/cards\/[0-9a-z]{26}$/);
  const links = page.locator('.card-links');
  await expect(links).toContainText(NEW_ACCOUNT);
  await expect(links).toContainText('(HK)');
  await expect(links).toContainText('消费资金来源');
  await expect(links).toContainText('默认');
  // The account is a real stored-value account with its currency.
  await links.getByRole('link', { name: NEW_ACCOUNT }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-z]{26}$/);
  await expect(page.locator('.account-head')).toContainText('储值账户');
  await expect(page.locator('.account-currencies')).toContainText('HKD');
  await expect(page.locator('.account-links')).toContainText(NEW_PREPAID);
  await page.goto('/cards');
});

test('shows the details with the regions kept apart, and edits the card', async () => {
  await tile(NEW_CARD).locator('.card-face').click();
  await expect(page).toHaveURL(/\/cards\/[0-9a-z]{26}$/);
  const info = page.locator('.card-info');
  await expect(info).toContainText(CARDS_SEED.bank);
  // Issuer's country (SG), card's issuing country (GB): two different facts, shown apart.
  await expect(field(info, '发卡机构所在地')).toContainText('(SG)');
  await expect(field(info, '发卡国家/地区')).toContainText('(GB)');
  await expect(info).toContainText('2029-05 · 有效至 2029-05-31');
  await expect(page.locator('.card-detail')).toContainText('不代表资金所在地');
  await expect(page.locator('.card-links')).toContainText('暂无关联账户');
  await expect(page.locator('#root')).not.toContainText(FULL_NUMBER);
  await shot(page, '33-card-detail');

  await page.getByRole('button', { name: '编辑银行卡' }).click();
  const form = dialog(/^编辑银行卡$/);
  await expect(form.locator('.card-last4 input').first()).toHaveValue('8');
  await form.getByLabel('卡片名称', { exact: true }).fill(NEW_CARD_RENAMED);
  await form.getByLabel('备注', { exact: true }).fill('出行备用');
  await save(form);
  await expect(form).toBeHidden();
  await expect(page.locator('.card-detail-head')).toContainText(NEW_CARD_RENAMED);
  await expect(info).toContainText('出行备用');
  await page.reload();
  await expect(page.locator('.card-detail-head')).toContainText(NEW_CARD_RENAMED);
  await page.goto('/cards');
});

test('filters by issuer, type, network, form, expiry and search; table view', async () => {
  await expect(tileNames()).toHaveCount(7);
  await pick('发卡机构', CARDS_SEED.emi, page.locator('.filter-row'));
  await expect(tileNames()).toHaveText([NEW_PREPAID, CARDS_SEED.noExpiryCard]);
  await clearSelect('发卡机构');
  await pick('卡片类型', '预付卡', page.locator('.filter-row'), false);
  await expect(tileNames()).toHaveText([NEW_PREPAID, CARDS_SEED.noExpiryCard]);
  await clearSelect('卡片类型');
  await pick('卡组织', 'Mastercard', page.locator('.filter-row'), false);
  await expect(tileNames()).toHaveText([CARDS_SEED.expiredCard, CARDS_SEED.noExpiryCard]);
  await clearSelect('卡组织');
  await pick('卡片形态', '虚拟卡', page.locator('.filter-row'), false);
  await expect(tileNames()).toHaveText([NEW_CARD_RENAMED, CARDS_SEED.longCard]);
  await clearSelect('卡片形态');
  // The reminder's "show" applies the expiry filter; every card shown carries that tag.
  await page.locator('[data-reminder="expired"]').getByRole('button', { name: btn('查看') }).click();
  await expect(tileNames()).toHaveText([CARDS_SEED.expiredCard]);
  await clearSelect('到期状态');
  for (const [label, status, names] of [
    ['即将到期', 'expiring', [CARDS_SEED.linkedCard]],
    ['无到期日期', 'none', [NEW_PREPAID, CARDS_SEED.noExpiryCard]],
    ['未到期', 'valid', [NEW_CARD_RENAMED, CARDS_SEED.longCard, CARDS_SEED.archivedIssuerCard]],
  ] as const) {
    await pick('到期状态', label, page.locator('.filter-row'), false);
    await expect(tileNames()).toHaveText([...names]);
    for (const tag of await page.locator('.card-tile .expiry-tag').all()) await expect(tag).toHaveAttribute('data-expiry', status);
    await clearSelect('到期状态');
  }
  await page.getByLabel('搜索卡片名称、机构或后四位').fill(CARDS_SEED.linkedLast4);
  await expect(tileNames()).toHaveText([CARDS_SEED.linkedCard]);
  await page.getByLabel('搜索卡片名称、机构或后四位').fill('预付机构');
  await expect(tileNames()).toHaveText([NEW_PREPAID, CARDS_SEED.noExpiryCard]);
  await page.getByLabel('搜索卡片名称、机构或后四位').fill('');
  await expect(tileNames()).toHaveCount(7);

  await page.locator('.view-toggle').getByText('列表', { exact: true }).click();
  const rows = page.locator('.card-table tbody tr.ant-table-row');
  await expect(rows).toHaveCount(7);
  const archivedRow = rows.filter({ hasText: CARDS_SEED.archivedIssuerCard });
  await expect(archivedRow).toContainText('已归档');
  await expect(archivedRow).toContainText('英国 (GB)');
  await shot(page, '34-cards-table');
  await page.locator('.view-toggle').getByText('卡面', { exact: true }).click();
  await expect(tiles()).toHaveCount(7);
});

test('freezes, deactivates and restores a card; the expiry tag never changes its status', async () => {
  const card = () => tile(CARDS_SEED.expiredCard);
  await card().getByRole('button', { name: '冻结', exact: true }).click();
  await expect(card().locator('.card-tile-tags')).toContainText('已冻结');
  await expect(card().locator('.card-face-status')).toHaveText('已冻结');
  await card().getByRole('button', { name: '解除冻结', exact: true }).click();
  await expect(card().locator('.card-tile-tags')).toContainText('正常');
  await card().getByRole('button', { name: '停用', exact: true }).click();
  await expect(confirmBox()).toContainText('停用后卡片资料与账户关联都会保留');
  await confirmBox().getByRole('button', { name: btn('停用') }).click();
  await expect(card()).toHaveCount(0);
  // Deactivated cards are hidden by default and no longer counted by the expired reminder.
  await expect(page.locator('[data-reminder="expired"]')).toHaveCount(0);
  await page.locator('.filter-row .ant-segmented').first().getByText('已停用', { exact: true }).click();
  await expect(tileNames()).toHaveText([CARDS_SEED.expiredCard]);
  await expect(card().locator('.card-face-status')).toHaveText('已停用');
  await card().getByRole('button', { name: '恢复', exact: true }).click();
  await expect(card()).toHaveCount(0);
  await page.locator('.filter-row .ant-segmented').first().getByText('未停用', { exact: true }).click();
  await expect(card().locator('.card-tile-tags')).toContainText('正常');
  await expect(page.locator('[data-reminder="expired"]')).toBeVisible();
});

test('a linked card: the dialog lists what goes with it, suggests deactivating, and deletes only after the last four digits; the accounts stay', async () => {
  await tile(CARDS_SEED.linkedCard).locator('.card-face').click();
  const links = page.locator('.card-links');
  await expect(links).toContainText(CARDS_SEED.account);
  await expect(links).toContainText('账户所属法域: 新加坡 (SG)');
  await expect(links.locator('.link-history')).toContainText('充值来源');
  await expect(page.locator('.card-channels')).toContainText(CARDS_SEED.wallet);
  const deleteButton = page.locator('.card-detail-actions').getByRole('button', { name: '删除', exact: true });
  await deleteButton.click();
  let box = dialog(/删除银行卡/);
  // Every category with its count, and what is not deleted.
  await expect(box.locator('[data-impact="links"]')).toHaveText('账户关联记录 2 条（有效 1、暂停 0、已结束 1）');
  await expect(box.locator('[data-impact="sources"]')).toHaveText('支付渠道来源记录 2 条（有效 1、已结束 1）');
  await expect(box).toContainText('不会删除：关联的账户及其币种、支付渠道本身、其他银行卡与其他用户的任何记录');
  await expect(box).toContainText('这只是防止误操作的确认，不是身份验证。');
  // Deactivating is the suggested (primary) action; deleting is secondary and locked.
  const deactivate = box.getByRole('button', { name: '改为停用' });
  await expect(deactivate).toHaveClass(/ant-btn-primary/);
  const ok = () => box.locator('.ant-modal-footer .ant-btn-dangerous');
  await expect(ok()).not.toHaveClass(/ant-btn-primary/);
  await expect(ok()).toBeDisabled();
  await box.getByLabel(`请输入卡号后四位 ${CARDS_SEED.linkedLast4} 以确认删除`).fill('1111');
  await expect(ok()).toBeDisabled();
  await shot(page, '35-card-delete-guard');
  // Taking the suggestion keeps the card, its links and its channel sources.
  await deactivate.click();
  await expect(box).toBeHidden();
  await expect(page.locator('.card-detail-tags')).toContainText('已停用');
  await expect(links).toContainText(CARDS_SEED.account);

  // Deleting it after all (already deactivated: no suggestion left).
  await deleteButton.click();
  box = dialog(/删除银行卡/);
  await expect(box.locator('[data-impact="links"]')).toBeVisible();
  await expect(box.getByRole('button', { name: '改为停用' })).toHaveCount(0);
  await expect(ok()).toBeDisabled();
  await box.getByLabel(`请输入卡号后四位 ${CARDS_SEED.linkedLast4} 以确认删除`).fill(CARDS_SEED.linkedLast4);
  await expect(ok()).toBeEnabled();
  await ok().click();
  await expect(page).toHaveURL(/\/cards$/);
  await page.locator('.filter-row .ant-segmented').first().getByText('全部', { exact: true }).click();
  await expect(tile(CARDS_SEED.longCard)).toBeVisible();
  await expect(tile(CARDS_SEED.linkedCard)).toHaveCount(0);
  await page.locator('.filter-row .ant-segmented').first().getByText('未停用', { exact: true }).click();

  // An unlinked card is deleted with a plain confirmation.
  await tile(NEW_CARD_RENAMED).getByRole('button', { name: '删除', exact: true }).click();
  const plain = dialog(/删除银行卡/);
  await expect(plain).toContainText('删除仅用于纠正误录');
  await expect(plain).not.toContainText('关联记录');
  await expect(plain.getByRole('button', { name: '改为停用' })).toHaveCount(0);
  await plain.locator('.ant-modal-footer .ant-btn-dangerous').click();
  await expect(tile(NEW_CARD_RENAMED)).toHaveCount(0);

  // The account the deleted card was linked to is untouched.
  await page.goto('/accounts');
  await expect(page.locator('.account-table tr.ant-table-row').filter({ hasText: CARDS_SEED.account })).toBeVisible();
  await page.goto('/cards');
});

test("another user's card cannot be opened or found", async () => {
  await page.goto(`/cards/${CARDS_SEED.otherUsersCardId}`);
  await expect(page.getByText('银行卡不存在或已被删除')).toBeVisible();
  await expect(page.locator('#root')).not.toContainText(CARDS_SEED.otherUsersCard);
  await page.goto('/cards');
  await page.locator('.filter-row .ant-segmented').first().getByText('全部', { exact: true }).click();
  await page.getByLabel('搜索卡片名称、机构或后四位').fill('Other User');
  await expect(tiles()).toHaveCount(0);
  await expect(page.locator('.card-grid, .ant-empty')).toContainText('没有符合条件的银行卡');
});

test('far-east and far-west time zones get the same answers from the filter and the tags, in English too', async ({ browser }) => {
  const session = await context.storageState();
  for (const timezoneId of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const other = await browser.newContext({ storageState: session, timezoneId, locale: 'en-US' });
    await other.addInitScript(() => localStorage.setItem('xui-v1-lang', 'en'));
    const p = await other.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await p.goto('/cards');
    await expect(p.getByRole('button', { name: 'New card' })).toBeVisible();
    await expect(p.locator('.card-tile')).toHaveCount(5);
    for (const [label, status, count] of [
      ['Expired', 'expired', 1],
      ['Not expiring', 'valid', 2],
      ['No expiry date', 'none', 2],
    ] as const) {
      const input = p.locator('.filter-row').getByLabel('Expiry', { exact: true });
      await input.click();
      const listId = await input.getAttribute('aria-controls');
      await p.locator('.ant-select-dropdown').filter({ has: p.locator(`[id="${listId}"]`) }).locator('.ant-select-item-option').filter({ hasText: new RegExp(`^${label}$`) }).click();
      // The server filtered on the browser's own day (today=); every card it returned carries the same tag.
      const tags = p.locator('.card-tile .expiry-tag');
      await expect(tags).toHaveCount(count);
      for (const tag of await tags.all()) await expect(tag).toHaveAttribute('data-expiry', status);
      const select = p.locator('.filter-row .ant-select').filter({ has: p.getByLabel('Expiry', { exact: true }) });
      await select.hover();
      await select.locator('.ant-select-clear').click();
    }
    await expect(p.locator('#root')).toContainText('Valid through');
    expect(errors, timezoneId).toEqual([]);
    await other.close();
  }
});

test('never shows a balance, an amount or a full card number, and the console stays clean', async () => {
  await page.goto('/cards');
  await expect(tiles().first()).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('余额');
  await expect(page.locator('#root')).not.toContainText(/合计|总额|总资产|≈/);
  await expect(page.locator('#root')).not.toContainText(FULL_NUMBER);
  await tile(NEW_PREPAID).locator('.card-face').click();
  await expect(page.locator('.card-detail-head')).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('余额');
  await expect(page.locator('#root')).not.toContainText(FULL_NUMBER);
  expect(consoleErrors).toEqual([]);
});
