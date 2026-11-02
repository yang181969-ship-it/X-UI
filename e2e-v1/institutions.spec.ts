import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { OWNER, OWNER_TOTP_SECRET, SEED, totp } from './fixtures.ts';

/**
 * M2-B2.1 browser journey through the real production build: sign in → 账户 → 机构 → create,
 * duplicate detection, same name in another country, sensitive-data refusal, search and filters,
 * edit, archive / restore, delete (unreferenced and referenced), details drawer, user isolation.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("确 定").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

const modal = () => page.locator('.ant-modal:visible').last();
const drawer = () => page.locator('.ant-drawer.ant-drawer-open');
const rows = () => page.locator('.institution-table tbody tr.ant-table-row');
const row = (name: string | RegExp) => rows().filter({ has: page.locator('.row-title', { hasText: name }) });

/** Choose an option in the antd Select labelled `label` inside `scope`. */
async function pick(label: string, option: string | RegExp, scope = page.locator('body')) {
  const input = scope.getByLabel(label, { exact: true });
  await input.click();
  if (typeof option === 'string') await input.pressSequentially(option);
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

async function fillForm(v: { name?: string; country?: string; type?: string; website?: string; notes?: string }) {
  const m = modal();
  if (v.name !== undefined) await m.getByLabel('名称', { exact: true }).fill(v.name);
  if (v.type) await pick('机构类型', v.type, m);
  if (v.country) await pick('国家/地区', v.country, m);
  if (v.website !== undefined) await m.getByLabel('网站', { exact: true }).fill(v.website);
  if (v.notes !== undefined) await m.getByLabel('备注', { exact: true }).fill(v.notes);
}

// The primary footer button: after it has been loading once, antd keeps a hidden "loading" icon in
// its accessible name, so it is not looked up by name.
const save = () => modal().locator('.ant-modal-footer .ant-btn-primary').click();

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected HTTP errors the browser logs on its own: the anonymous /auth/me probe (401) and the
    // duplicate / in-use answers this journey provokes on purpose (409).
    if (/the server responded with a status of (401|409)/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
});

test('signs in and opens 账户 → 机构', async () => {
  await page.goto('/accounts');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(OWNER.username);
  await page.getByPlaceholder('密码').fill(OWNER.password);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(OWNER_TOTP_SECRET));
  await page.getByRole('button', { name: btn('登录') }).click();
  // Back to the page that asked for the sign-in.
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('heading', { name: '账户' })).toBeVisible();
  await page.getByRole('tab', { name: '机构' }).click();
  await expect(page).toHaveURL(/\/accounts\?tab=institutions$/);
  // The seeded institution with its account reference; the other user's institution is not listed.
  await expect(row(SEED.referencedInstitution)).toContainText('1 个账户 · 0 张银行卡 · 0 个支付渠道');
  await expect(row(SEED.referencedInstitution)).toContainText('新加坡 (SG)');
  await expect(page.getByText(SEED.otherUsersInstitution)).toHaveCount(0);
  // The tab is part of the URL: a reload stays on it.
  await page.reload();
  await expect(page.getByRole('tab', { name: '机构', selected: true })).toBeVisible();
});

test('creates an institution with colour + initials avatar', async () => {
  await page.getByRole('button', { name: '新建机构' }).click();
  await expect(modal()).toContainText('新建机构');
  // There is no logo upload — only colour swatches.
  await expect(modal().locator('input[type=file]')).toHaveCount(0);
  await fillForm({ name: 'Northwind Bank', country: '(HK)', website: 'https://northwind.example', notes: '测试用机构，非真实数据' });
  await modal().getByRole('radio', { name: '#722ed1' }).click();
  await shot(page, '01-institution-form');
  await save();
  await expect(modal()).toBeHidden();
  const nw = row('Northwind Bank');
  await expect(nw).toContainText('银行');
  await expect(nw).toContainText('(HK)');
  await expect(nw).toContainText('northwind.example');
  const avatar = nw.locator('.institution-avatar');
  await expect(avatar).toHaveText('NO');
  await expect(avatar).toHaveCSS('background-color', 'rgb(114, 46, 209)');
});

test('refuses a normalized duplicate in the same country and links to the existing one', async () => {
  await page.getByRole('button', { name: '新建机构' }).click();
  await fillForm({ name: '  ＮＯＲＴＨＷＩＮＤ   bank ', country: '(HK)' });
  await save();
  const alert = modal().locator('.ant-alert');
  await expect(alert).toContainText('已存在同名机构');
  await shot(page, '02-duplicate');
  await alert.getByRole('button', { name: '查看已有机构' }).click();
  await expect(modal()).toBeHidden();
  await expect(drawer()).toContainText('Northwind Bank');
  await expect(drawer()).toContainText('https://northwind.example');
  await drawer().locator('.ant-drawer-close').click();
  await expect(rows().filter({ hasText: /northwind/i })).toHaveCount(1);
});

test('allows the same name in another country', async () => {
  await page.getByRole('button', { name: '新建机构' }).click();
  await fillForm({ name: 'Northwind Bank', country: '(GB)', type: '电子货币 / 支付机构' });
  await save();
  await expect(modal()).toBeHidden();
  await expect(row('Northwind Bank')).toHaveCount(2);
  await expect(row('Northwind Bank').filter({ hasText: '(GB)' })).toContainText('电子货币 / 支付机构');
});

test('refuses card numbers and security codes in the name and notes', async () => {
  await page.getByRole('button', { name: '新建机构' }).click();
  await fillForm({ name: 'Leaky Bank', notes: '卡号 4111 1111 1111 1111' });
  await save();
  await expect(modal().locator('.ant-form-item').filter({ hasText: '备注' })).toContainText('疑似包含卡号或 CVV / PIN，无法保存');
  await fillForm({ notes: '', name: 'Leaky PIN 1234' });
  await save();
  await expect(modal().locator('.ant-form-item').filter({ hasText: '名称' }).first()).toContainText('疑似包含卡号或 CVV / PIN');
  await shot(page, '03-sensitive');
  await modal().getByRole('button', { name: btn('取消') }).click();
  await expect(row(/Leaky/)).toHaveCount(0);
});

test('searches and filters by country, type and status', async () => {
  const search = page.getByPlaceholder('搜索机构名称');
  await search.fill('ｎｏｒｔｈｗｉｎｄ'); // full-width: matched like the name key
  await expect(rows()).toHaveCount(2);
  await pick('国家/地区', '(GB)', page.locator('.filter-row'));
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText('(GB)');
  await pick('机构类型', '银行', page.locator('.filter-row'));
  await expect(page.getByText('没有符合条件的机构')).toBeVisible();
  await clearSelect('机构类型');
  await clearSelect('国家/地区');
  await search.fill('');
  await expect(rows()).toHaveCount(3);
  await pick('机构类型', '电子货币 / 支付机构', page.locator('.filter-row'));
  await expect(rows()).toHaveCount(1);
  await clearSelect('机构类型');
  await expect(rows()).toHaveCount(3);
});

test('edits an institution', async () => {
  const hk = row('Northwind Bank').filter({ hasText: '(HK)' });
  await hk.getByRole('button', { name: '编辑机构' }).click();
  await expect(modal()).toContainText('编辑机构');
  await expect(modal().getByLabel('名称', { exact: true })).toHaveValue('Northwind Bank');
  await fillForm({ name: 'Northwind Bank HK', notes: '已更新' });
  await save();
  await expect(modal()).toBeHidden();
  await expect(row('Northwind Bank HK')).toContainText('(HK)');
  // Moving the GB one to HK is fine: "Northwind Bank" and "Northwind Bank HK" are different names…
  await row(/^Northwind Bank$/).getByRole('button', { name: '编辑机构' }).click();
  await fillForm({ country: '(HK)' });
  await save();
  await expect(modal()).toBeHidden();
  await expect(row(/^Northwind Bank$/)).toContainText('(HK)');
  // …but renaming it to the other one's name (any spelling) in the same country is a duplicate.
  await row(/^Northwind Bank$/).getByRole('button', { name: '编辑机构' }).click();
  await fillForm({ name: 'northwind bank hk' });
  await save();
  await expect(modal().locator('.ant-alert')).toContainText('已存在同名机构');
  await modal().getByRole('button', { name: btn('取消') }).click();
});

test('archives and restores; archived institutions are hidden by default', async () => {
  const target = row(/^Northwind Bank$/);
  await target.getByRole('button', { name: '归档' }).click();
  await expect(page.getByText('已归档').first()).toBeVisible();
  await expect(row(/^Northwind Bank$/)).toHaveCount(0);
  await page.locator('.filter-row .ant-segmented').getByText('已归档', { exact: true }).click();
  await expect(rows()).toHaveCount(1);
  await expect(row(/^Northwind Bank$/)).toContainText('已归档');
  await shot(page, '04-archived');
  await row(/^Northwind Bank$/).getByRole('button', { name: '恢复' }).click();
  await expect(page.locator('.institution-table')).toContainText('没有符合条件的机构');
  await page.locator('.filter-row .ant-segmented').getByText('全部', { exact: true }).click();
  await expect(rows()).toHaveCount(3);
  await page.locator('.filter-row .ant-segmented').getByText('正常', { exact: true }).click();
  await expect(rows()).toHaveCount(3);
});

test('deletes an unreferenced institution after confirmation', async () => {
  await row('Northwind Bank HK').getByRole('button', { name: '删除' }).click();
  const confirm = page.locator('.ant-modal-confirm:visible');
  await expect(confirm).toContainText('删除机构「Northwind Bank HK」？');
  await expect(confirm).toContainText('只能归档');
  await confirm.getByRole('button', { name: btn('删除') }).click();
  await expect(row('Northwind Bank HK')).toHaveCount(0);
  await expect(rows()).toHaveCount(2);
});

test('a referenced institution cannot be deleted; archiving is offered instead', async () => {
  await row(SEED.referencedInstitution).getByRole('button', { name: '删除' }).click();
  await page.locator('.ant-modal-confirm:visible').getByRole('button', { name: btn('删除') }).click();
  const inUse = page.locator('.ant-modal-confirm:visible').filter({ hasText: '仍被引用' });
  await expect(inUse).toContainText('1 个账户、0 张银行卡、0 个支付渠道');
  await shot(page, '05-in-use');
  await inUse.getByRole('button', { name: btn('归档') }).click();
  await expect(row(SEED.referencedInstitution)).toHaveCount(0);
  await page.locator('.filter-row .ant-segmented').getByText('全部', { exact: true }).click();
  await expect(row(SEED.referencedInstitution)).toContainText('已归档');
});

test('the details drawer lists what references the institution', async () => {
  await row(SEED.referencedInstitution).locator('.row-title').click();
  const d = drawer();
  await expect(d).toContainText('机构详情');
  await expect(d).toContainText(SEED.referencedInstitution);
  await expect(d).toContainText('1 个账户 · 0 张银行卡 · 0 个支付渠道');
  await expect(d.locator('.ref-section').first()).toContainText(SEED.referencingAccount);
  await shot(page, '06-detail');
  await d.getByRole('button', { name: '恢复' }).click();
  await expect(d.locator('.institution-head')).not.toContainText('已归档');
  await d.locator('.ant-drawer-close').click();
});

test('never shows a balance, and the console stays clean', async () => {
  await expect(page.locator('#root')).not.toContainText('余额');
  expect(consoleErrors).toEqual([]);
});
