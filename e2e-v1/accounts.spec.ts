import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { ACCOUNTS_SEED, ACCOUNTS_TOTP_SECRET, ACCOUNTS_USER, SEED, totp } from './fixtures.ts';

/**
 * M2-B2.2 browser journey through the real production build, as its own user: 账户 tab grouped by
 * institution → create a multi-currency account (creating its institution inside the form, the
 * jurisdiction chosen by hand) → details → manage currencies (default switch, close, add, remove;
 * a linked currency can only be closed) → edit (institution locked) → freeze / close / reopen →
 * filters and flat view → delete (balance account refused, own account deleted) → no balance, no
 * other user's data, clean console.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("确 定").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
let createdUrl = '';

const NEW_ACCOUNT = 'Contoso 多币种账户';
const NEW_INSTITUTION = 'Contoso EMI';

const modal = () => page.locator('.ant-modal:visible').last();
/** A dialog by its title (nested dialogs are not necessarily last in the DOM). */
const dialog = (title: string | RegExp) => page.locator('.ant-modal:visible').filter({ has: page.locator('.ant-modal-title', { hasText: title }) });
const confirmBox = () => page.locator('.ant-modal-confirm:visible');
const rows = () => page.locator('.account-table tbody tr.ant-table-row');
const row = (name: string | RegExp) => rows().filter({ has: page.locator('.row-title', { hasText: name }) });
const group = (institution: string) => page.locator('.account-group').filter({ has: page.locator('.account-group-name', { hasText: institution }) });
const save = (m: Locator = modal()) => m.locator('.ant-modal-footer .ant-btn-primary').click();
const currencyRow = (code: string) => page.locator(`.ant-modal:visible .currency-row-edit[data-currency="${code}"]`);
const tags = (scope: Locator) => scope.locator('.currency-tag');

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

const statusFilter = (label: string) => page.locator('.filter-row .ant-segmented').first().getByText(label, { exact: true }).click();

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected HTTP errors the browser logs on its own: the anonymous /auth/me probe (401), the
    // in-use answers this journey provokes on purpose (409) and the page of a deleted account (404).
    if (/the server responded with a status of (401|404|409)/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in and lists the accounts grouped by institution', async () => {
  await page.goto('/accounts');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(ACCOUNTS_USER.username);
  await page.getByPlaceholder('密码').fill(ACCOUNTS_USER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(ACCOUNTS_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('tab', { name: '账户', selected: true })).toBeVisible();

  const bank = group(ACCOUNTS_SEED.bank);
  await expect(bank).toContainText('1 个账户');
  const linked = bank.locator('tr.ant-table-row').filter({ hasText: ACCOUNTS_SEED.linkedAccount });
  await expect(linked).toContainText('银行账户 · 储蓄 · •••• 0042');
  await expect(linked).toContainText('新加坡 (SG)');
  await expect(tags(linked)).toHaveText(['SGD', 'USD', 'EUR']);
  await expect(linked.locator('.currency-tag.is-default')).toHaveText('SGD');
  await expect(linked).toContainText('1 张');
  await expect(group(ACCOUNTS_SEED.emi)).toContainText(ACCOUNTS_SEED.balanceAccount);
  // Another user's accounts and institutions are not listed.
  await expect(page.getByText(SEED.referencingAccount)).toHaveCount(0);
  await expect(page.getByText(SEED.referencedInstitution)).toHaveCount(0);
  await shot(page, '10-accounts-grouped');
});

test('creates a multi-currency account, creating its institution inside the form', async () => {
  await page.getByRole('button', { name: '新建账户' }).first().click();
  const form = dialog(/^新建账户$/);
  await expect(form).toBeVisible();
  // The jurisdiction is never pre-filled.
  await expect(form.locator('.ant-form-item').filter({ hasText: '账户所属法域' })).toContainText('选择国家/地区');

  await form.getByRole('button', { name: '新建机构' }).click();
  const inst = dialog(/^新建机构$/);
  await expect(inst).toBeVisible();
  await inst.getByLabel('名称', { exact: true }).fill(NEW_INSTITUTION);
  await pick('机构类型', '电子货币 / 支付机构', inst, false);
  await pick('国家/地区', '(GB)', inst);
  await save(inst);
  await expect(inst).toBeHidden();
  // The new institution is now selected in the account form.
  await expect(form.locator('.ant-form-item').filter({ hasText: '开户机构' }).first()).toContainText(NEW_INSTITUTION);

  await form.getByLabel('账户名称', { exact: true }).fill(NEW_ACCOUNT);
  await pick('账户类型', '电子货币账户', form, false);
  // Saving without a jurisdiction or a currency is refused by the form.
  await save(form);
  await expect(form).toContainText('请选择账户所属法域');
  await expect(form).toContainText('至少需要一个币种');
  await pick('账户所属法域', '(BE)', form);
  for (const code of ['USD', 'EUR', 'GBP']) await pick('添加币种', code, form);
  await expect(currencyRow('USD')).toContainText('默认'); // the first one added
  await currencyRow('EUR').locator('.ant-radio-wrapper, .ant-radio').first().click();
  await expect(currencyRow('EUR')).toContainText('默认');
  await expect(currencyRow('USD')).not.toContainText('默认');
  await expect(currencyRow('EUR').locator('.ant-radio-wrapper input')).toBeChecked();
  await expect(currencyRow('USD').locator('.ant-radio-wrapper input')).not.toBeChecked();
  await form.getByLabel('账号尾号', { exact: true }).fill('7788');
  await shot(page, '11-account-form');
  await save(form);
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);

  const created = group(NEW_INSTITUTION).locator('tr.ant-table-row').filter({ hasText: NEW_ACCOUNT });
  await expect(created).toContainText('电子货币账户 · •••• 7788');
  await expect(created).toContainText('比利时 (BE)');
  await expect(tags(created)).toHaveText(['USD', 'EUR', 'GBP']);
  await expect(created.locator('.currency-tag.is-default')).toHaveText('EUR');
});

test('refuses card numbers and security codes in the form', async () => {
  await page.getByRole('button', { name: '新建账户' }).first().click();
  await modal().getByLabel('账户名称', { exact: true }).fill('Leaky 4111 1111 1111 1111');
  await modal().getByLabel('备注', { exact: true }).fill('cvv 123');
  await save();
  await expect(modal().locator('.ant-form-item').filter({ hasText: '账户名称' }).first()).toContainText('疑似包含卡号或 CVV / PIN');
  await expect(modal().locator('.ant-form-item').filter({ hasText: '备注' }).first()).toContainText('疑似包含卡号或 CVV / PIN');
  await modal().getByRole('button', { name: btn('取消') }).click();
  await expect(row(/Leaky/)).toHaveCount(0);
});

test('opens the details page: jurisdiction, currencies, no linked cards yet', async () => {
  await row(NEW_ACCOUNT).locator('.row-title').click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-z]{26}$/);
  createdUrl = page.url();
  const detail = page.locator('.account-detail');
  await expect(detail.locator('.account-head')).toContainText(NEW_ACCOUNT);
  await expect(detail.locator('.account-head')).toContainText(NEW_INSTITUTION);
  await expect(detail.locator('.account-info')).toContainText('比利时 (BE)');
  await expect(detail.locator('.account-info')).toContainText('•••• 7788');
  await expect(tags(detail.locator('.account-currencies'))).toHaveText(['USD', 'EUR', 'GBP']);
  await expect(detail.locator('.account-links')).toContainText('暂无关联的银行卡');
  await expect(detail.locator('.account-channels')).toContainText('无');
  await shot(page, '12-account-detail');
  // A reload keeps the page (deep link).
  await page.reload();
  await expect(page.locator('.account-head')).toContainText(NEW_ACCOUNT);
});

test('manages currencies: closes one, adds one, removes one; the default cannot be closed', async () => {
  await page.getByRole('button', { name: '管理币种' }).click();
  await expect(modal()).toContainText(`管理币种 · ${NEW_ACCOUNT}`);
  // The default (EUR) can be neither closed nor removed.
  await expect(currencyRow('EUR').getByRole('button', { name: '移除 EUR' })).toBeDisabled();
  await currencyRow('GBP').getByText('已关闭', { exact: true }).click();
  await pick('添加币种', 'JPY', modal());
  await currencyRow('USD').getByRole('button', { name: '移除 USD' }).click();
  await currencyRow('JPY').getByRole('button', { name: '上移 JPY' }).click();
  await shot(page, '13-currencies');
  await save();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  const box = page.locator('.account-currencies');
  await expect(tags(box)).toHaveText(['EUR', 'JPY', 'GBP']);
  await expect(box.locator('.currency-tag.is-closed')).toHaveText('GBP');
  await expect(box.locator('.currency-closed-group')).toContainText('已关闭');
  // Active and closed currencies are listed apart.
  await expect(box.locator('.currency-section[data-status="active"] .row-item')).toHaveText([/^EUR/, /^JPY/]);
  await expect(box.locator('.currency-section[data-status="closed"]')).toContainText('已关闭币种');
  await expect(box.locator('.currency-section[data-status="closed"] .row-item')).toHaveText([/^GBP/]);
  await expect(box.locator('.row-item[data-currency="GBP"]')).toContainText('已关闭');
});

test('edits the account; the institution is locked', async () => {
  await page.locator('.account-head').getByRole('button', { name: '编辑账户' }).click();
  const form = modal();
  await expect(form.getByLabel('开户机构', { exact: true })).toBeDisabled();
  await expect(form).toContainText('开户机构创建后不可修改');
  // Currencies are managed on the detail page, not in the edit dialog.
  await expect(form.locator('.currency-editor')).toHaveCount(0);
  await expect(form.getByLabel('账户名称', { exact: true })).toHaveValue(NEW_ACCOUNT);
  await form.getByLabel('备注', { exact: true }).fill('测试备注，非真实数据');
  await save();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(page.locator('.account-info')).toContainText('测试备注，非真实数据');
});

test('freezes, unfreezes, closes and reopens from the detail page', async () => {
  const head = page.locator('.account-head');
  await head.getByRole('button', { name: '冻结' }).click();
  await expect(head).toContainText('已冻结');
  await head.getByRole('button', { name: '解除冻结' }).click();
  await expect(head).toContainText('正常');
  await head.getByRole('button', { name: '关闭账户' }).click();
  await expect(confirmBox()).toContainText('不再作为新交易的资金来源');
  await confirmBox().getByRole('button', { name: btn('关闭账户') }).click();
  await expect(head).toContainText('已关闭');
  // Closed accounts are hidden from the default list…
  await page.locator('.back-link').click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(row(NEW_ACCOUNT)).toHaveCount(0);
  // …and listed under 已关闭, where they can be reopened.
  await statusFilter('已关闭');
  await expect(rows()).toHaveCount(1);
  await expect(row(NEW_ACCOUNT)).toContainText('已关闭');
  await row(NEW_ACCOUNT).getByRole('button', { name: '恢复账户' }).click();
  await expect(page.getByText('没有符合条件的账户')).toBeVisible();
  await statusFilter('未关闭');
  await expect(row(NEW_ACCOUNT)).toContainText('正常');
});

test('a currency used by a card link can only be closed; the link stays visible', async () => {
  await row(ACCOUNTS_SEED.linkedAccount).locator('.row-title').click();
  const links = page.locator('.account-links');
  await expect(links).toContainText(ACCOUNTS_SEED.card);
  await expect(links).toContainText('•••• 4242');
  await expect(links.locator('.ref-section').first()).toContainText('EUR');
  await expect(links).toContainText('消费资金来源');
  await page.getByRole('button', { name: '管理币种' }).click();
  await currencyRow('EUR').getByRole('button', { name: '移除 EUR' }).click();
  await save();
  await expect(modal().locator('.ant-alert')).toContainText('EUR 仍被银行卡关联引用，不能移除');
  await shot(page, '14-currency-in-use');
  await modal().getByRole('button', { name: btn('取消') }).click();
  await page.getByRole('button', { name: '管理币种' }).click();
  await currencyRow('EUR').getByText('已关闭', { exact: true }).click();
  await save();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(page.locator('.account-currencies .currency-tag.is-closed')).toHaveText('EUR');
  await expect(page.locator('.account-currencies .currency-section[data-status="closed"]')).toContainText('EUR');
  // The link, its scope and default flag are untouched.
  await expect(links).toContainText(ACCOUNTS_SEED.card);
  await expect(links).toContainText('默认');
  await page.locator('.back-link').click();
  // The list marks the closed currency too (still shown: the currency filter includes it).
  const linked = row(ACCOUNTS_SEED.linkedAccount);
  await expect(linked.locator('.currency-tag[data-status="active"]')).toHaveText(['SGD', 'USD']);
  await expect(linked.locator('.currency-closed-group')).toContainText('已关闭');
  await expect(linked.locator('.currency-closed-group .currency-tag')).toHaveText(['EUR']);
});

test('searches and filters; the flat view shows the institution column', async () => {
  const search = page.getByPlaceholder('搜索账户、机构或尾号');
  await search.fill('ｃｏｎｔｏｓｏ'); // full-width: matched like the name key
  await expect(rows()).toHaveCount(1);
  await search.fill('0042'); // number hint
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText(ACCOUNTS_SEED.linkedAccount);
  await search.fill('');
  await expect(rows()).toHaveCount(3);
  await pick('账户所属法域', '(LU)', page.locator('.filter-row'));
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText(ACCOUNTS_SEED.balanceAccount);
  await clearSelect('账户所属法域');
  await pick('币种', 'JPY', page.locator('.filter-row'));
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText(NEW_ACCOUNT);
  await clearSelect('币种');
  await pick('账户类型', '银行账户', page.locator('.filter-row'), false);
  await expect(rows()).toHaveCount(1);
  await clearSelect('账户类型');
  await pick('开户机构', ACCOUNTS_SEED.emi, page.locator('.filter-row'));
  await expect(rows()).toHaveCount(1);
  await clearSelect('开户机构');
  await expect(rows()).toHaveCount(3);

  await page.locator('.view-toggle').getByText('平铺', { exact: true }).click();
  await expect(page.locator('.account-group')).toHaveCount(0);
  await expect(page.locator('.account-table thead')).toContainText('开户机构');
  await expect(row(NEW_ACCOUNT)).toContainText(NEW_INSTITUTION);
  await shot(page, '15-accounts-flat');
  // The choice is remembered.
  await page.reload();
  await expect(page.locator('.account-group')).toHaveCount(0);
  await page.locator('.view-toggle').getByText('按机构分组', { exact: true }).click();
  await expect(page.locator('.account-group')).toHaveCount(3);
});

test('a payment channel balance account cannot be deleted; closing is offered instead', async () => {
  await row(ACCOUNTS_SEED.balanceAccount).getByRole('button', { name: '删除' }).click();
  await expect(confirmBox()).toContainText('仅用于纠正误录');
  await confirmBox().getByRole('button', { name: btn('删除') }).click();
  const inUse = confirmBox().filter({ hasText: '仍被引用' });
  await expect(inUse).toContainText(ACCOUNTS_SEED.channel);
  await shot(page, '16-account-in-use');
  await inUse.getByRole('button', { name: btn('关闭账户') }).click();
  await expect(row(ACCOUNTS_SEED.balanceAccount)).toHaveCount(0);
  await statusFilter('全部');
  await expect(row(ACCOUNTS_SEED.balanceAccount)).toContainText('已关闭');
  await statusFilter('未关闭');
});

test('deletes an account after confirmation; its institution counts follow', async () => {
  await page.goto(createdUrl);
  await page.locator('.account-head').getByRole('button', { name: '删除' }).click();
  await expect(confirmBox()).toContainText(`删除账户「${NEW_ACCOUNT}」？`);
  await confirmBox().getByRole('button', { name: btn('删除') }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(row(NEW_ACCOUNT)).toHaveCount(0);
  await expect(group(NEW_INSTITUTION)).toHaveCount(0);
  // The institution is no longer referenced.
  await page.getByRole('tab', { name: '机构' }).click();
  await expect(page.locator('.institution-table tr.ant-table-row').filter({ hasText: NEW_INSTITUTION })).toContainText('0 个账户');
  // A deleted account's page says so.
  await page.goto(createdUrl);
  await expect(page.getByText('账户不存在或已被删除')).toBeVisible();
});

test('an archived institution keeps its accounts but takes no new ones until restored', async () => {
  // Both tab panes stay mounted: scope to the tab panel.
  const panel = (tab: '账户' | '机构') => page.getByRole('tabpanel', { name: tab });
  const institutionRow = () => panel('机构').locator('.institution-table tbody tr.ant-table-row').filter({ hasText: ACCOUNTS_SEED.emi });
  const statusSegment = (tab: '账户' | '机构') => panel(tab).locator('.filter-row .ant-segmented').first();
  const optionInForm = async () => {
    await page.getByRole('button', { name: '新建账户' }).first().click();
    const form = dialog(/^新建账户$/);
    const input = form.getByLabel('开户机构', { exact: true });
    await input.click();
    const listId = await input.getAttribute('aria-controls');
    return { form, option: page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) }).locator('.ant-select-item-option').filter({ hasText: ACCOUNTS_SEED.emi }) };
  };

  await page.goto('/accounts?tab=institutions');
  await institutionRow().getByRole('button', { name: '归档' }).click();
  await expect(institutionRow()).toHaveCount(0);
  await page.getByRole('tab', { name: '账户' }).click();
  await statusSegment('账户').getByText('全部', { exact: true }).click();
  // Its (closed) account is still listed, under an archived group without a "new account" action.
  const archivedGroup = group(ACCOUNTS_SEED.emi);
  await expect(archivedGroup).toContainText('已归档');
  await expect(archivedGroup).toContainText(ACCOUNTS_SEED.balanceAccount);
  await expect(archivedGroup.getByRole('button', { name: '新建账户' })).toHaveCount(0);
  // The create form shows it as disabled, under "restore first".
  let { form, option } = await optionInForm();
  await expect(option).toHaveClass(/ant-select-item-option-disabled/);
  await expect(page.locator('.ant-select-dropdown:visible')).toContainText('已归档（恢复后才能新建账户）');
  await shot(page, '17-archived-institution');
  await page.keyboard.press('Escape');
  await form.getByRole('button', { name: btn('取消') }).click();
  await expect(form).toBeHidden();

  // Restored: selectable again.
  await page.getByRole('tab', { name: '机构' }).click();
  await statusSegment('机构').getByText('已归档', { exact: true }).click();
  await institutionRow().getByRole('button', { name: '恢复' }).click();
  await expect(institutionRow()).toHaveCount(0);
  await page.getByRole('tab', { name: '账户' }).click();
  await expect(group(ACCOUNTS_SEED.emi).getByRole('button', { name: '新建账户' })).toBeVisible();
  ({ form, option } = await optionInForm());
  await expect(option).not.toHaveClass(/ant-select-item-option-disabled/);
  await option.click();
  await expect(form.locator('.ant-form-item').filter({ hasText: '开户机构' }).first()).toContainText(ACCOUNTS_SEED.emi);
  await form.getByRole('button', { name: btn('取消') }).click();
  await expect(form).toBeHidden();
});

test('never shows a balance or a total, and the console stays clean', async () => {
  await page.goto('/accounts');
  await expect(rows().first()).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('余额');
  await expect(page.locator('#root')).not.toContainText(/合计|总额|总资产|≈/);
  await row(ACCOUNTS_SEED.linkedAccount).locator('.row-title').click();
  await expect(page.locator('.account-head')).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('余额');
  await expect(page.locator('#root')).not.toContainText(/合计|总额|总资产|≈/);
  expect(consoleErrors).toEqual([]);
});
