import { resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { OTHER, OTHER_TOTP_SECRET, SETTINGS_TOTP_SECRET, SETTINGS_USER, totp } from './fixtures.ts';

/**
 * M2-B2.3 browser journey through the real production build, as its own user: 设置 → 通用 shows
 * the default home region CN (reading it writes no row) → save another region → a failed save is
 * reported and changes nothing → reload → sign out and in again → save CN explicitly (no 默认 tag)
 * → another user still has the default CN →
 * English texts → clean console. The throwaway e2e database is read directly to check the rows.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("保 存").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;
let db: Client;
const consoleErrors: string[] = [];
/** Set while the journey makes the server answer 500 on purpose. */
let expect500 = false;

const card = () => page.locator('.home-region-card');
const current = () => card().locator('.home-region-current');
// After it has been loading once, antd keeps a hidden "loading" icon in the button's accessible
// name, so it is found by its place, and its label checked as text.
const saveButton = () => card().locator('.home-region-edit .ant-btn-primary');
const prefRows = async () =>
  (await db.execute({ sql: 'SELECT p.home_region FROM user_preferences p JOIN users u ON u.id = p.user_id WHERE u.username = ?', args: [SETTINGS_USER.username] })).rows.map((r) => r.home_region);

/** TOTP codes can't be replayed: wait for a code this user has not used yet. */
const usedCodes = new Map<string, Set<string>>();
async function freshCode(secret: string) {
  const used = usedCodes.get(secret) ?? new Set<string>();
  usedCodes.set(secret, used);
  await expect.poll(() => totp(secret), { timeout: 35_000, intervals: [500] }).not.toMatch(new RegExp(`^(${[...used].join('|') || '-'})$`));
  const code = totp(secret);
  used.add(code);
  return code;
}

async function signIn(user: { username: string; password: string }, secret: string) {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(user.username);
  await page.getByPlaceholder('密码').fill(user.password);
  const code = await freshCode(secret);
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(code);
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page).toHaveURL(/\/settings$/);
}

async function signOut() {
  await page.getByRole('menuitem', { name: /退出登录|Sign out/ }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function openGeneral() {
  await page.getByRole('tab', { name: /^(通用|General)$/ }).click();
  await expect(card()).toBeVisible();
}

/** Choose a region in the home-region select by typing part of its name. */
async function pickRegion(search: string, option: string | RegExp) {
  const input = card().getByLabel('国家或地区', { exact: true });
  await input.click();
  await input.pressSequentially(search);
  const listId = await input.getAttribute('aria-controls');
  const popup = page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${listId}"]`) });
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

test.beforeAll(async ({ browser }) => {
  db = createClient({ url: `file:${resolve(import.meta.dirname, '../data/e2e-v1/x-ui-v1.db')}` });
  context = await browser.newContext();
  page = await context.newPage();
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    // Expected HTTP errors the browser logs on its own: the anonymous /auth/me probe (401) and the
    // failure this journey simulates on purpose (500).
    if (/the server responded with a status of 401/.test(m.text())) return;
    if (expect500 && /the server responded with a status of 500/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?')));
    consoleErrors.push(`${m.text()} ${JSON.stringify(args)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});

test.afterAll(async () => {
  await context.close();
  db?.close();
});

test('设置 → 通用 shows the default CN with its explanation; reading it writes no row', async () => {
  await signIn(SETTINGS_USER, SETTINGS_TOTP_SECRET);
  await openGeneral();
  await expect(card().locator('.ant-card-head')).toContainText('本国 / 基准地区');
  await expect(card()).toContainText('当前本国地区');
  await expect(current()).toHaveText(/^中国 \(CN\)\s*默认$/);
  await expect(card()).toContainText('未修改时默认为 中国 (CN)。只对你本人生效，不影响其他用户。');
  await expect(card()).toContainText('本设置用于将来判断交易是否涉及境外金融活动。');
  await expect(card()).toContainText('修改设置不会自动重分类已经保存的历史交易。');
  await expect(card().locator('.ant-select')).toContainText('中国 (CN)');
  await expect(saveButton()).toBeDisabled();
  await expect(saveButton()).toHaveText(btn('保存'));
  // The display and language settings are still there.
  await expect(page.getByText('主题', { exact: true })).toBeVisible();
  expect(await prefRows()).toEqual([]);
  await shot(page, '20-settings-home-region-default');
});

test('saves another region: success message, current value updated, one row', async () => {
  await pickRegion('香港', '(HK)');
  await expect(saveButton()).toBeEnabled();
  await saveButton().click();
  await expect(page.locator('.ant-message-success')).toContainText('本国地区已保存');
  await expect(current()).toHaveText(/^\S+ \(HK\)$/);
  await expect(saveButton()).toBeDisabled();
  expect(await prefRows()).toEqual(['HK']);
});

test('a failed save shows an error and keeps the saved value', async () => {
  expect500 = true;
  await page.route('**/api/settings/profile', (route) =>
    route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal error', code: 'INTERNAL' }) }) : route.fallback(),
  );
  await pickRegion('新加坡', '(SG)');
  await saveButton().click();
  await expect(page.locator('.ant-message-error')).toContainText('internal error');
  await expect(current()).toHaveText(/^\S+ \(HK\)$/);
  // The choice stays in the selector so it can be saved again.
  await expect(card().locator('.ant-select')).toContainText('新加坡 (SG)');
  await expect(saveButton()).toBeEnabled();
  await page.unroute('**/api/settings/profile');
  expect500 = false;
  expect(await prefRows()).toEqual(['HK']);

  await saveButton().click();
  await expect(page.locator('.ant-message-success').last()).toContainText('本国地区已保存');
  await expect(current()).toHaveText('新加坡 (SG)');
  expect(await prefRows()).toEqual(['SG']);
});

test('the saved region survives a reload', async () => {
  await page.reload();
  await openGeneral();
  await expect(current()).toHaveText('新加坡 (SG)');
  await expect(card().locator('.ant-select')).toContainText('新加坡 (SG)');
  await expect(saveButton()).toBeDisabled();
});

test('the saved region survives signing out and in again', async () => {
  await signOut();
  await signIn(SETTINGS_USER, SETTINGS_TOTP_SECRET);
  await openGeneral();
  await expect(current()).toHaveText('新加坡 (SG)');
  await shot(page, '21-settings-home-region-saved');
});

test('saving CN explicitly keeps it as the user’s own choice: no 默认 tag', async () => {
  await pickRegion('中国', /^中国 \(CN\)$/);
  await saveButton().click();
  await expect(page.locator('.ant-message-success').last()).toContainText('本国地区已保存');
  await expect(current()).toHaveText('中国 (CN)');
  await expect(current().locator('.ant-tag')).toHaveCount(0);
  expect(await prefRows()).toEqual(['CN']);
  await page.reload();
  await openGeneral();
  await expect(current()).toHaveText('中国 (CN)');
});

test('another user still has the default CN, with the 默认 tag', async () => {
  await signOut();
  await signIn(OTHER, OTHER_TOTP_SECRET);
  await openGeneral();
  await expect(current()).toHaveText(/^中国 \(CN\)\s*默认$/);
  expect(await prefRows()).toEqual(['CN']);
});

test('English texts, and the console stays clean', async () => {
  await page.locator('.ant-segmented').getByText('English', { exact: true }).click();
  await expect(card().locator('.ant-card-head')).toContainText('Home region');
  await expect(current()).toHaveText(/^China \(CN\)\s*Default$/);
  await expect(card()).toContainText('Defaults to China (CN) until you change it.');
  await expect(card()).toContainText('Used later to tell whether a transaction involves financial activity abroad.');
  await expect(card()).toContainText('Changing it does not reclassify transactions that are already saved.');
  await page.locator('.ant-segmented').getByText('中文', { exact: true }).click();
  await expect(card().locator('.ant-card-head')).toContainText('本国 / 基准地区');
  await signOut();
  expect(consoleErrors).toEqual([]);
});
