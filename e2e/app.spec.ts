import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import dayjs from 'dayjs';
import { ADMIN, ADMIN_TOTP_SECRET, totp } from './fixtures.ts';

/**
 * End-to-end journey through the real UI (production build), in order:
 * login → passkey → multi-currency ledger + card → bills with history → custom field (saved in
 * the DB) → US stocks → FX conversion → stats → BIN lookup → themes / mobile.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// antd puts a space between two CJK characters in buttons ("确 定").
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);

let context: BrowserContext;
let page: Page;

/** Choose an option in the antd Select labelled `label` (scoped to that select's own popup). */
async function pick(p: Page, label: string, option: string | RegExp) {
  const input = p.getByLabel(label, { exact: true });
  await input.click();
  // Searchable selects: type to filter (long lists are virtualised).
  if ((await input.getAttribute('readonly')) === null) await input.pressSequentially(typeof option === 'string' ? option : option.source);
  const listId = await input.getAttribute('aria-controls');
  const popup = listId ? p.locator('.ant-select-dropdown').filter({ has: p.locator(`[id="${listId}"]`) }) : p.locator('.ant-select-dropdown:visible').last();
  await popup.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
  await expect(popup).toBeHidden();
}

const modal = (p: Page) => p.locator('.ant-modal:visible').last();

async function okModal(p: Page) {
  await modal(p).getByRole('button', { name: btn('确定') }).click();
}

async function typeOtp(p: Page, code: string) {
  await p.locator('.ant-otp input').first().click();
  await p.keyboard.type(code);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  // Virtual platform authenticator (like Touch ID) so passkeys work headlessly.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
});

test.afterAll(async () => {
  await context.close();
});

test('the one-time setup link is dead once the account exists', async () => {
  await page.goto('/setup/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByText('设置链接无效，或账号已经创建')).toBeVisible();
});

test('signs in with password + Google Authenticator code', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByPlaceholder('用户名').fill(ADMIN.username);
  await page.getByPlaceholder('密码').fill(ADMIN.password);
  await typeOtp(page, totp(ADMIN_TOTP_SECRET));
  await shot(page, '01-login');
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page.getByRole('heading', { name: `欢迎，${ADMIN.displayName}` })).toBeVisible();
  await expect(page.getByText('从添加第一家银行开始')).toBeVisible();
});

test('registers a passkey and signs in with it', async () => {
  await page.goto('/security');
  await page.getByRole('button', { name: '添加 Passkey' }).click();
  await expect(page.getByText('Passkey 已添加')).toBeVisible();
  await expect(page.locator('.row-item').filter({ hasText: 'Chrome' }).first()).toBeVisible();

  await page.locator('.app-sidebar').hover();
  await page.getByText('退出登录').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: '使用 Passkey 登录' }).click();
  await expect(page.getByRole('heading', { name: `欢迎，${ADMIN.displayName}` })).toBeVisible();
});

test('sets up banks, multi-currency accounts, a card and transactions', async () => {
  await page.goto('/accounts');
  const addInstitution = async (name: string, country?: string) => {
    await page.getByRole('button', { name: '添加机构' }).first().click();
    await page.getByLabel('名称', { exact: true }).fill(name);
    if (country) await pick(page, '国家/地区', country);
    await okModal(page);
    await expect(page.locator('.ant-card-head').filter({ hasText: name })).toBeVisible();
  };
  /** Rows of the currency editor: [currency (blank = keep the default USD), opening balance]. */
  const addAccount = async (bank: string, name: string, rows: [string | null, string][], type?: string) => {
    await page.locator('.ant-card').filter({ has: page.locator('.ant-card-head', { hasText: bank }) }).getByRole('button', { name: '添加账户' }).click();
    await page.getByLabel('名称', { exact: true }).fill(name);
    if (type) await pick(page, '类型', type);
    for (const [i, [cur, opening]] of rows.entries()) {
      if (i > 0) await modal(page).getByRole('button', { name: '添加币种' }).click();
      const row = modal(page).locator('.currency-row').nth(i);
      if (cur) {
        await row.locator('.ant-select').click();
        await page.keyboard.type(cur);
        await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${cur}$`) }).first().click();
      }
      await row.locator('input.ant-input-number-input').fill(opening);
    }
    await okModal(page);
    await expect(page.locator('.row-title').filter({ hasText: name })).toBeVisible();
  };
  await addInstitution('Chase'); // default country: United States
  await addInstitution('HSBC HK', '中国香港');
  await addInstitution('Wise', '全球 / 不限国家');
  await addAccount('Chase', 'Checking', [[null, '10000']]);
  await addAccount('Chase', 'Sapphire', [[null, '0']], '信用卡账户');
  await addAccount('HSBC HK', 'HKD Savings', [['HKD', '5000']]);
  await addAccount('Wise', 'Multi', [
    [null, '500'],
    ['EUR', '0'],
  ]);
  // Zero balances are hidden: the multi-currency account only lists USD.
  const multi = page.locator('#root .row-item').filter({ hasText: /^Multi/ });
  await expect(multi).toContainText('$500.00');
  await expect(multi).not.toContainText('€');
  await shot(page, '03-accounts');

  // Stripe-style card: full number (encrypted), MM / YY expiry.
  await page.goto('/cards');
  await page.getByRole('button', { name: '添加卡片' }).click();
  await pick(page, '关联账户', /Sapphire/);
  const pan = page.getByLabel('卡号', { exact: true });
  await pan.pressSequentially('4242424242424242');
  await expect(pan).toHaveValue('4242 4242 4242 4242');
  await expect(pan).toBeFocused(); // typing never loses focus
  await page.getByLabel('有效期', { exact: true }).pressSequentially('1230');
  await expect(page.getByLabel('有效期', { exact: true })).toHaveValue('12 / 30');
  await pick(page, '卡类型', '信用卡');
  await page.getByLabel('账单日', { exact: true }).fill('5');
  await page.getByLabel('还款日', { exact: true }).fill('23');
  await page.getByLabel('卡片昵称', { exact: true }).fill('Sapphire Visa');
  await page.getByLabel('持卡人', { exact: true }).fill('ADMIN');
  await shot(page, '04-card-form');
  await okModal(page);
  await expect(page.locator('#root .bank-card .card-nick').filter({ hasText: 'Sapphire Visa' })).toBeVisible();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await shot(page, '05-cards');

  await page.locator('#root .card-tile').first().click();
  await page.getByRole('button', { name: '显示完整卡号' }).click();
  await expect(page.locator('.ant-drawer .card-number').first()).toHaveText('4242 4242 4242 4242');
  await shot(page, '05b-card-revealed');
  await page.keyboard.press('Escape');

  // An expense with a new tag, then a USD → HKD transfer.
  await page.goto('/transactions');
  await page.getByRole('button', { name: '记一笔' }).click();
  await pick(page, '账户', /Checking/);
  await page.getByLabel('金额', { exact: true }).fill('35.5');
  await pick(page, '分类', '餐饮');
  await page.getByLabel('商户 / 对方', { exact: true }).fill('午饭');
  await page.getByLabel('标签', { exact: true }).fill('日常');
  await page.keyboard.press('Enter');
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-table-row').filter({ hasText: '午饭' })).toContainText('-$35.50');

  await page.getByRole('button', { name: '记一笔' }).click();
  await modal(page).locator('.ant-segmented-item').filter({ hasText: '转账' }).click();
  await pick(page, '转出账户', /Checking/);
  await pick(page, '转入账户', /HKD Savings/);
  await page.getByLabel('金额', { exact: true }).fill('1000');
  await page.getByLabel('到账金额', { exact: true }).fill('7800');
  await expect(page.getByText('实际汇率 1 USD = 7.8000 HKD')).toBeVisible();
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-table-row').filter({ hasText: '转至' })).toContainText('-$1,000.00');
  await shot(page, '06-transactions');

  await page.goto('/');
  // USD: 10,000 − 35.50 − 1,000 + 500 (Wise); HKD: 5,000 + 7,800.
  await expect(page.locator('.stat-net').filter({ hasText: '9,464.50' })).toBeVisible();
  await expect(page.locator('.stat-net').filter({ hasText: '12,800.00' })).toBeVisible();
  await page.waitForTimeout(800); // let the number animation settle for the screenshot
  await shot(page, '02-dashboard');
});

test('subscription since two months ago records its history; the current one is paid', async () => {
  await page.goto('/bills');
  await page.getByRole('button', { name: '添加账单' }).first().click();
  await page.getByLabel('名称', { exact: true }).fill('ChatGPT');
  await page.getByLabel('金额', { exact: true }).fill('20');
  const start = page.getByLabel('首次扣款日', { exact: true });
  await start.click();
  await start.fill(dayjs().subtract(2, 'month').format('YYYY-MM-DD'));
  await start.press('Enter');
  await expect(modal(page).getByText('记为已付并生成流水')).toBeVisible();
  await pick(page, '付款账户 / 卡', /Checking/);
  await okModal(page);
  await expect(page.getByText('历史记录 · 2')).toBeVisible();

  const row = page.locator('.row-item').filter({ hasText: 'ChatGPT' }).filter({ hasText: '待付' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click(); // 标记已付
  await okModal(page);
  await expect(page.getByText('历史记录 · 3')).toBeVisible();
  await page.getByText('历史记录 · 3').click();
  await expect(page.locator('.ant-collapse .row-item').filter({ hasText: 'ChatGPT' })).toHaveCount(3);
  await shot(page, '07-bills');
});

test('adds the custom field 账户状态 from the UI (stored in the database)', async () => {
  await page.goto('/settings');
  await page.getByRole('button', { name: '添加栏位' }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('账户状态');
  await expect(page.getByLabel('字段键', { exact: true })).toHaveValue('field_1');
  await page.getByLabel('字段键', { exact: true }).fill('status');
  await modal(page).getByRole('button', { name: '添加选项' }).click();
  const labels = modal(page).getByPlaceholder('显示');
  const values = modal(page).getByPlaceholder('值');
  await labels.nth(1).fill('冻结');
  await values.nth(1).fill('frozen');
  await page.getByLabel('标签栏', { exact: true }).fill('账户状态');
  await okModal(page);
  await expect(page.locator('.save-bar')).toContainText('add account field 账户状态');
  await shot(page, '08-settings-fields');
  await page.getByRole('button', { name: '预览并保存' }).click();
  await expect(page.locator('.diff-view')).toContainText('"label": "账户状态"');
  await shot(page, '09-settings-diff');
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.getByText('配置已保存')).toBeVisible();
  await expect(page.locator('.save-bar')).toHaveCount(0);

  // Survives a reload (it lives in the DB) and is immediately usable on accounts.
  await page.goto('/accounts');
  await page.locator('#root .row-item').filter({ hasText: /^Checking/ }).click();
  await page.locator('.ant-drawer').getByRole('button', { name: /编\s*辑/ }).click();
  await pick(page, '账户状态', '冻结');
  await okModal(page);
  await page.locator('.ant-drawer .ant-tabs-tab').filter({ hasText: '账户状态' }).click();
  await expect(page.locator('.ant-drawer .ant-descriptions')).toContainText('冻结');
  await shot(page, '10-account-drawer');
  await page.keyboard.press('Escape');
  await expect(page.locator('#root .row-item').filter({ hasText: /^Checking/ })).toContainText('冻结');
});

test('records US stocks in an investment account, paid from Checking', async () => {
  // Shares live in an account of type 投资; the money moves in another account.
  await page.goto('/accounts');
  await page.locator('.ant-card').filter({ has: page.locator('.ant-card-head', { hasText: 'Chase' }) }).getByRole('button', { name: '添加账户' }).click();
  await page.getByLabel('名称', { exact: true }).fill('Brokerage');
  await pick(page, '类型', '投资');
  await okModal(page);
  await expect(page.locator('.row-title').filter({ hasText: 'Brokerage' })).toBeVisible();

  await page.goto('/invest');
  await page.getByRole('button', { name: '记录买卖' }).click();
  await page.getByLabel('代码', { exact: true }).fill('aapl');
  await page.getByLabel('股数', { exact: true }).fill('2');
  await page.getByLabel('成交价', { exact: true }).fill('150');
  await expect(modal(page).locator('.ant-select').filter({ hasText: 'Brokerage' })).toBeVisible(); // the only investment account
  await pick(page, '扣款账户', /Checking/);
  await okModal(page);
  const aapl = page.locator('.ant-table-row').filter({ hasText: 'AAPL' }).first();
  await expect(aapl).toContainText('$300.00');
  await expect(aapl).toContainText('$150.00'); // prices always show two decimals

  // Bought by total amount: $100 for 3 shares → $33.33 a share (not 33.333333).
  await page.getByRole('button', { name: '记录买卖' }).click();
  await page.getByLabel('代码', { exact: true }).fill('MSFT');
  await page.getByLabel('股数', { exact: true }).fill('3');
  await modal(page).locator('.ant-segmented-item').filter({ hasText: '按成交金额' }).click();
  await page.getByLabel('成交金额', { exact: true }).fill('100');
  await pick(page, '扣款账户', /Checking/);
  await okModal(page);
  const msft = page.locator('.ant-table-row').filter({ hasText: 'MSFT' }).first();
  await expect(msft).toContainText('$33.33');
  await expect(msft).not.toContainText('33.3333');

  await aapl.getByRole('button', { name: '—' }).click(); // no price yet → set it by hand
  await modal(page).getByRole('textbox').fill('200');
  await okModal(page);
  await expect(aapl).toContainText('+$100.00');
  await expect(page.locator('.stat-tile').filter({ hasText: '市值' })).toContainText('$400.00');
  // The P/L totals are colored like the rows below (gain = income green in the dark theme).
  await expect(page.locator('.stat-tile').filter({ hasText: '浮动盈亏' }).locator('.ant-statistic-content')).toHaveCSS('color', 'rgb(115, 209, 61)');
  await shot(page, '16-invest');

  // The investment account is worth its market value; the cash left Checking.
  await page.goto('/accounts');
  const brokerage = page.locator('#root .row-item').filter({ hasText: /^Brokerage/ });
  await expect(brokerage).toContainText('$400.00');
  await expect(brokerage).toContainText('持仓市值');

  // The cash legs move Checking's money but stay out of the transactions list…
  await page.goto('/transactions');
  await expect(page.locator('.ant-table-row').filter({ hasText: '午饭' })).toBeVisible();
  await expect(page.locator('.ant-table-row').filter({ hasText: 'BUY AAPL' })).toHaveCount(0);
  // …unless filtered by type, where they are read-only.
  await page.goto('/transactions?type=trade');
  await page.locator('.ant-table-row').filter({ hasText: '-$300.00' }).click();
  await expect(modal(page)).toContainText('这是股票交易的资金记录');
  await page.keyboard.press('Escape');
});

test('converts the net worth with a manual rate, in a currency of your choice', async () => {
  await page.goto('/fx');
  const hkd = page.locator('.ant-table-row').filter({ hasText: 'HKD' });
  await hkd.getByRole('button', { name: '修改汇率' }).click();
  await modal(page).getByRole('spinbutton').fill('7.8');
  await okModal(page);
  await expect(hkd).toContainText('7.8 HKD');
  await expect(hkd).toContainText('手动');
  await shot(page, '17-fx');

  await page.goto('/');
  // USD 9,404.50 = cash 9,004.50 (after bills, $300 + $100 of stock) + Brokerage $400; HKD 12,800 / 7.8.
  await expect(page.locator('.stat-net').filter({ hasText: '9,404.50' })).toBeVisible();
  const tile = page.locator('.stat-converted');
  await expect(tile).toContainText('折合');
  await expect(tile.locator('.stat-net')).toHaveText('$11,045.53');
  await tile.locator('.convert-currency').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^HKD$/ }).click();
  await expect(tile.locator('.stat-net')).toHaveText('HK$86,155.10');
  await page.waitForTimeout(800);
  await shot(page, '02b-dashboard-converted');
  await tile.locator('.convert-currency').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^USD$/ }).click();
  await expect(tile.locator('.stat-net')).toHaveText('$11,045.53');
});

test('statistics: KPIs, monthly chart with tooltip, category ranking', async () => {
  await page.goto('/stats');
  // 35.50 lunch + 3 × 20 ChatGPT; transfers and stock trades are not spending.
  await expect(page.locator('.stat-tile').filter({ hasText: '支出' })).toContainText('$95.50');
  const monthly = page.locator('.ant-card').filter({ hasText: '月度收支' });
  await expect(monthly.locator('.viz-plot svg')).toBeVisible();
  await monthly.locator('.viz-group').last().hover();
  await expect(monthly.locator('.viz-tooltip')).toContainText(dayjs().format('YYYY-MM'));
  await expect(page.locator('.viz-rank-row').filter({ hasText: '餐饮' })).toContainText('$35.50');
  await shot(page, '18-stats');
  await page.locator('.ant-segmented-item').filter({ has: page.locator('.anticon-table') }).click();
  await expect(page.locator('.ant-table-row').filter({ hasText: dayjs().format('YYYY-MM') })).toBeVisible();
  await expect(page.getByRole('switch')).toBeChecked(); // stock gains counted by default
  // Stock money in/out of Checking is shown on its own (buying shares is not spending).
  await expect(page.locator('.ant-card').filter({ hasText: '股票资金进出' })).toContainText('$400.00');
});

test('hidden small spending: out of the list by default, still in the statistics', async () => {
  await page.goto('/transactions');
  await page.getByRole('button', { name: '记一笔' }).click();
  await pick(page, '账户', /Checking/);
  await page.getByLabel('金额', { exact: true }).fill('3');
  await page.getByLabel('商户 / 对方', { exact: true }).fill('Snack');
  await modal(page).getByText('hidden（琐碎消费').click();
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await expect(page.locator('.ant-table-row').filter({ hasText: 'Snack' })).toHaveCount(0);
  await page.locator('.switch-label').filter({ hasText: '显示 hidden' }).getByRole('switch').click();
  await expect(page.locator('.ant-table-row').filter({ hasText: 'Snack' })).toContainText('hidden');
  await page.locator('.switch-label').filter({ hasText: '显示 hidden' }).getByRole('switch').click();
  await page.goto('/stats');
  await expect(page.locator('.stat-tile').filter({ hasText: '支出' })).toContainText('$98.50'); // 95.50 + 3
});

test('credit usage sits on its own line and over-limit is reminded', async () => {
  await page.goto('/accounts');
  await page.locator('.ant-card').filter({ has: page.locator('.ant-card-head', { hasText: 'Chase' }) }).getByRole('button', { name: '添加账户' }).click();
  await page.getByLabel('名称', { exact: true }).fill('Amex');
  await pick(page, '类型', '信用卡账户');
  await modal(page).locator('.currency-row').first().locator('input.ant-input-number-input').fill('-1200');
  await page.getByLabel('信用额度', { exact: true }).fill('1000');
  await okModal(page);
  const row = page.locator('#root .row-item').filter({ hasText: /^Amex/ });
  await expect(row).toContainText('超出额度 $200.00');
  // Nothing overlaps: the usage line starts below the type line.
  const sub = await row.locator('.row-sub').boundingBox();
  const usage = await row.locator('.row-extra').boundingBox();
  expect(usage!.y).toBeGreaterThanOrEqual(sub!.y + sub!.height - 1);
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await shot(page, '22-credit-usage');
  await page.locator('.topbar').getByRole('button', { name: '提醒' }).click();
  await expect(page.locator('.ant-popover').getByText('超出信用额度')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('BIN lookup from the static files (when generated)', async () => {
  const generated = existsSync(resolve(import.meta.dirname, '../apps/web/public/bin/meta.json'));
  await page.goto('/bins');
  if (!generated) {
    await expect(page.getByText('BIN 库尚未生成')).toBeVisible();
    return;
  }
  const input = page.getByPlaceholder('输入卡号前 6 位');
  await input.fill('4242');
  await expect(page.getByText(/共 \d+ 个匹配的 BIN/)).toBeVisible();
  await input.fill('424242');
  await expect(page.locator('.ant-descriptions').first()).toContainText('VISA');
  // The card added earlier is listed with its BIN.
  await expect(page.locator('.ant-table-row').filter({ hasText: '424242' })).toBeVisible();

  // Correct the public record by hand on the card; the correction wins everywhere.
  await page.goto('/cards');
  await page.locator('#root .card-tile').first().click();
  await page.locator('.ant-drawer').getByRole('button', { name: /编\s*辑/ }).click();
  await modal(page).getByRole('button', { name: '修正' }).click();
  await modal(page).locator('.bin-editor input').first().fill('MY BANK');
  await modal(page).getByRole('button', { name: '使用这些信息' }).click();
  await expect(modal(page).locator('.bin-line')).toContainText('MY BANK');
  await expect(modal(page).locator('.bin-line')).toContainText('已手动修正');
  await okModal(page);
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await page.goto('/bins');
  const mine = page.locator('.ant-table-row').filter({ hasText: '424242' });
  await expect(mine).toContainText('MY BANK');
  await expect(mine).toContainText('已手动修正');
  await page.getByPlaceholder('输入卡号前 6 位').fill('424242');
  await expect(page.locator('.ant-descriptions')).toHaveCount(2); // your correction + the public record
  await shot(page, '19-bins');
});

test('changes the profile picture', async () => {
  await page.goto('/security');
  // A 2×2 PNG; the browser crops and shrinks it before saving.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(page.locator('.topbar .ant-avatar img')).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/);
  await shot(page, '21-profile');
  await page.getByRole('button', { name: '使用文字头像' }).click();
  await expect(page.locator('.topbar .ant-avatar img')).toHaveCount(0);
});

test('theme switching and mobile layout', async ({ browser }) => {
  await page.goto('/');
  await page.locator('.app-sidebar').hover();
  await page.locator('.app-sidebar .icon-btn').filter({ has: page.locator('.anticon-bulb') }).click(); // dark → ultra
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ultra-dark');
  await page.mouse.move(800, 400);
  await shot(page, '12-dashboard-ultra');
  await page.locator('.app-sidebar').hover();
  await page.locator('.app-sidebar .icon-btn').filter({ has: page.locator('.anticon-bulb') }).click(); // ultra → light
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.mouse.move(800, 400);
  await page.waitForTimeout(300);
  await shot(page, '13-dashboard-light');
  await page.goto('/stats');
  await expect(page.locator('.viz-plot svg').first()).toBeVisible();
  await shot(page, '18b-stats-light');

  const state = await context.storageState();
  const phone = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.goto('/');
  await expect(p.locator('.drawer-handle')).toBeVisible();
  await p.waitForTimeout(800);
  await shot(p, '14-mobile-dashboard');
  await p.locator('.drawer-handle').click();
  await expect(p.locator('.nav-drawer .ant-drawer-section')).toBeVisible();
  await shot(p, '15-mobile-drawer');
  for (const [path, name] of [
    ['/cards', '20-mobile-cards'],
    ['/invest', '21-mobile-invest'],
    ['/stats', '22-mobile-stats'],
  ] as const) {
    await p.goto(path);
    await p.waitForTimeout(500);
    // The fixed top bar stays one row: nothing hangs off the right edge.
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    await shot(p, name);
  }
  await phone.close();
});
