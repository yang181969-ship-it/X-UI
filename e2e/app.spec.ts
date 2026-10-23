import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import dayjs from 'dayjs';
import { ADMIN, ADMIN_TOTP_SECRET, BASE_URL, totp } from './fixtures.ts';

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

/** Type a date into a currency row's balance-date picker. */
async function setBalanceDate(row: Locator, date: string) {
  const input = row.locator('.ant-picker input');
  await input.click();
  await input.fill(date);
  await input.press('Enter');
}

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
      // Balance as of long before the test data, so every transaction below counts.
      await setBalanceDate(row, '2025-01-01');
    }
    if (rows.length > 1) await shot(page, '03b-account-form');
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

test('converts the net worth with manual rates, in CNY by default', async () => {
  await page.goto('/fx');
  const setRate = async (code: string, rate: string) => {
    const row = page.locator('.ant-table-row').filter({ hasText: code });
    await row.getByRole('button', { name: '修改汇率' }).click();
    await modal(page).getByRole('spinbutton').fill(rate);
    await okModal(page);
    await expect(row).toContainText(`${rate} ${code}`);
    await expect(row).toContainText('手动');
  };
  await setRate('HKD', '7.8');
  await setRate('CNY', '7');
  await shot(page, '17-fx');

  await page.goto('/');
  // USD 9,404.50 = cash 9,004.50 (after bills, $300 + $100 of stock) + Brokerage $400; HKD 12,800.
  await expect(page.locator('.stat-net').filter({ hasText: '9,404.50' })).toBeVisible();
  const tile = page.locator('.stat-converted');
  await expect(tile).toContainText('折合');
  // Default CNY: $9,404.50 × 7 + HK$12,800 / 7.8 × 7.
  await expect(tile.locator('.convert-currency')).toContainText('CNY');
  await expect(tile.locator('.stat-net')).toHaveText('¥77,318.68');
  await page.waitForTimeout(800);
  await shot(page, '02b-dashboard-converted');
  const choose = async (code: string) => {
    await tile.locator('.convert-currency').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${code}$`) }).click();
  };
  await choose('HKD');
  await expect(tile.locator('.stat-net')).toHaveText('HK$86,155.10');
  await choose('USD');
  await expect(tile.locator('.stat-net')).toHaveText('$11,045.53');
  await choose('CNY');
  await expect(tile.locator('.stat-net')).toHaveText('¥77,318.68');
});

test('statistics: KPIs, monthly chart with tooltip, category ranking', async () => {
  // This month's income in another currency (HK$780 salary) must show up by default.
  await page.goto('/transactions');
  await page.getByRole('button', { name: '记一笔' }).click();
  await modal(page).locator('.ant-segmented-item').filter({ hasText: '收入' }).click();
  await pick(page, '账户', /HKD Savings/);
  await page.getByLabel('金额', { exact: true }).fill('780');
  await page.getByLabel('商户 / 对方', { exact: true }).fill('Salary');
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);

  await page.goto('/stats');
  // By default all currencies combined in CNY (HK$780 / 7.8 × 7 = ¥700), the current month included.
  await expect(page.locator('.ant-segmented-item-selected').filter({ hasText: '全部（折合 CNY）' })).toBeVisible();
  await expect(page.locator('.stat-tile').filter({ hasText: '收入' })).toContainText('¥700.00');
  await expect(page.locator('.stat-tile').filter({ hasText: '支出' })).toContainText('¥668.50'); // $95.50 × 7
  // USD only: 35.50 lunch + 3 × 20 ChatGPT; transfers and stock trades are not spending.
  await page.locator('.ant-segmented-item').filter({ hasText: /^USD$/ }).click();
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
  // One currency at a time is still possible.
  await page.locator('.ant-segmented-item').filter({ hasText: /^HKD$/ }).click();
  await expect(page.locator('.stat-tile').filter({ hasText: '收入' })).toContainText('HK$780.00');
  await page.locator('.ant-segmented-item').filter({ hasText: /^USD$/ }).click();
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
  await expect(page.locator('.stat-tile').filter({ hasText: '支出' })).toContainText('¥689.50'); // ($95.50 + $3) × 7
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

test('balance date: the synced balance includes that day; only later transactions count', async () => {
  await page.goto('/accounts');
  await page.locator('.ant-card').filter({ has: page.locator('.ant-card-head', { hasText: 'Wise' }) }).getByRole('button', { name: '添加账户' }).click();
  await page.getByLabel('名称', { exact: true }).fill('Wallet');
  const row = modal(page).locator('.currency-row').first();
  await row.locator('input.ant-input-number-input').fill('100');
  await setBalanceDate(row, dayjs().subtract(1, 'day').format('YYYY-MM-DD'));
  await okModal(page);
  const wallet = page.locator('#root .row-item').filter({ hasText: /^Wallet/ });
  await expect(wallet).toContainText('$100.00');

  const spend = async (amount: string, date: string, who: string) => {
    await page.goto('/transactions');
    await page.getByRole('button', { name: '记一笔' }).click();
    await pick(page, '账户', /Wallet/);
    await page.getByLabel('金额', { exact: true }).fill(amount);
    await page.getByLabel('商户 / 对方', { exact: true }).fill(who);
    const d = page.getByLabel('日期', { exact: true });
    await d.click();
    await d.fill(date);
    await d.press('Enter');
    await modal(page).getByRole('button', { name: btn('保存') }).click();
    await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  };
  await spend('30', dayjs().format('YYYY-MM-DD'), 'Today'); // after the balance date: counts
  await spend('50', dayjs().subtract(1, 'day').format('YYYY-MM-DD'), 'Yesterday'); // that day: already included
  await page.goto('/accounts');
  await expect(wallet).toContainText('$70.00');
  await wallet.click();
  await expect(page.locator('.ant-drawer .tx-not-counted')).toContainText('Yesterday');
  await shot(page, '23-balance-date');
  await page.keyboard.press('Escape');
});

test('optional transaction details: collapsed by default, saved, shown, edited and cleared', async () => {
  await page.goto('/transactions');
  await page.getByRole('button', { name: '记一笔' }).click();
  // The simple form stays as it was: the details are folded away.
  const details = modal(page).locator('.ant-collapse-item').filter({ hasText: '详细信息' });
  await expect(details).not.toHaveClass(/ant-collapse-item-active/);
  await pick(page, '账户', /Wallet/);
  await page.getByLabel('金额', { exact: true }).fill('5');
  await page.getByLabel('商户 / 对方', { exact: true }).fill('Taxi');
  await details.locator('.ant-collapse-header').click();
  const time = page.getByLabel('时间', { exact: true });
  await time.fill('2330');
  await time.blur();
  await expect(time).toHaveValue('23:30');
  await pick(page, '时区', 'America/Los_Angeles');
  await page.getByLabel('具体用途', { exact: true }).fill('机场接送');
  await page.getByLabel('订单号 / 交易参考号', { exact: true }).fill('RIDE-42');
  await pick(page, '核实状态', '已核实');
  await expect(details).toContainText('已填 5 项');
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);

  const row = page.locator('.ant-table-row').filter({ hasText: 'Taxi' });
  // Business date as entered (today), the local time under it; the time zone never moves the date.
  await expect(row).toContainText(dayjs().format('YYYY-MM-DD'));
  await expect(row).toContainText('23:30');
  await expect(row).toContainText('机场接送');
  await shot(page, '24-transaction-details');

  // Reopening shows the details expanded; clearing the time leaves it empty (no 00:00).
  await row.click();
  await expect(details).toHaveClass(/ant-collapse-item-active/);
  await expect(page.getByLabel('订单号 / 交易参考号', { exact: true })).toHaveValue('RIDE-42');
  await expect(page.getByLabel('时间', { exact: true })).toHaveValue('23:30');
  await modal(page).locator('.ant-input-affix-wrapper').filter({ has: page.getByLabel('时间', { exact: true }) }).locator('.ant-input-clear-icon').click();
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await expect(row).not.toContainText('23:30');
  await expect(row).toContainText('机场接送');

  // Details never change the balance: $70 − $5, and back after deleting.
  await page.goto('/accounts');
  const wallet = page.locator('#root .row-item').filter({ hasText: /^Wallet/ });
  await expect(wallet).toContainText('$65.00');
  await page.goto('/transactions');
  await row.click();
  await expect(page.getByLabel('时间', { exact: true })).toHaveValue('');
  await modal(page).getByRole('button', { name: /删\s*除/ }).click(); // icon + text
  await page.locator('.ant-popconfirm').getByRole('button', { name: btn('确定') }).click();
  await expect(page.locator('.ant-table-row').filter({ hasText: 'Taxi' })).toHaveCount(0);
  await page.goto('/accounts');
  await expect(wallet).toContainText('$70.00');
});

/**
 * occurredTime is a plain local "HH:mm" string. Editing a transaction must give it back exactly,
 * whatever the browser's own zone and date — even on a day its clocks skip 02:00–03:00
 * (America/New_York, 2026-03-08), where binding the time to "today" turned 02:30 into 03:30.
 */
for (const zone of [
  { timezoneId: 'Asia/Shanghai', label: 'Shanghai (no DST)', dstGap: false, noon: '2026-03-08T12:00:00+08:00' },
  { timezoneId: 'America/New_York', label: 'New York on its DST day', dstGap: true, noon: '2026-03-08T12:00:00-04:00' },
]) {
  test(`keeps the exact HH:mm when editing other fields — browser in ${zone.label}`, async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: await context.storageState(), timezoneId: zone.timezoneId, locale: 'zh-CN' });
    const p = await ctx.newPage();
    // Noon local time on 2026-03-08 in the browser (only the page's JS clock; the server keeps its own).
    await p.clock.setFixedTime(new Date(zone.noon));
    const api = async (method: string, path: string, data?: unknown) => {
      const r = await ctx.request.fetch(`${BASE_URL}/api${path}`, { method, data, headers: { origin: BASE_URL, 'x-zui-csrf': '1' } });
      expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
      return r.json();
    };
    const tag = zone.dstGap ? 'NY' : 'SH';
    const created: string[] = [];
    try {
      await p.goto('/transactions');
      // The browser really is in that zone and on that day (and, in New York, 02:30 doesn't exist locally).
      const env = await p.evaluate(() => ({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, today: new Date().toDateString(), h: new Date(2026, 2, 8, 2, 30).getHours() }));
      expect(env).toEqual({ zone: zone.timezoneId, today: 'Sun Mar 08 2026', h: zone.dstGap ? 3 : 2 });

      const accounts = await api('GET', '/accounts');
      const wallet = accounts.find((a: any) => a.name === 'Wallet').id;
      const checking = accounts.find((a: any) => a.name === 'Checking').id;
      const details = { timeZone: 'Asia/Hong_Kong', purpose: `dst-${tag}` };

      // Expenses at 01:30, 02:30 and 03:30: open each, change only the note, save.
      for (const occurredTime of ['01:30', '02:30', '03:30']) {
        const who = `DST-${tag}-${occurredTime}`;
        const tx = await api('POST', '/transactions', { type: 'expense', accountId: wallet, amount: 100, occurredAt: '2026-03-08', counterparty: who, occurredTime, ...details });
        created.push(tx.id);
        await p.reload();
        await p.locator('.ant-table-row').filter({ hasText: who }).click();
        await expect(p.getByLabel('时间', { exact: true })).toHaveValue(occurredTime);
        await p.getByLabel('备注', { exact: true }).fill('note only');
        await modal(p).getByRole('button', { name: btn('保存') }).click();
        await expect(p.locator('.ant-modal-wrap:visible')).toHaveCount(0);
        expect(await api('GET', `/transactions/${tx.id}`)).toMatchObject({ occurredAt: '2026-03-08', occurredTime, timeZone: 'Asia/Hong_Kong', note: 'note only' });
      }

      // A transfer at 02:30, edited from each side: both legs keep exactly 02:30.
      const x = await api('POST', '/transactions', { type: 'transfer', fromAccountId: wallet, toAccountId: checking, amount: 100, occurredAt: '2026-03-08', occurredTime: '02:30', ...details, purpose: `DST-XFER-${tag}` });
      created.push(x.id);
      const legs = async () => (await api('GET', '/transactions?type=transfer&pageSize=200')).items.filter((l: any) => l.transferGroupId === x.transferGroupId);
      for (const [side, edit] of [
        ['来自', async () => p.getByLabel('备注', { exact: true }).fill('edited from the receiving side')],
        ['转至', async () => p.getByLabel('订单号 / 交易参考号', { exact: true }).fill(`REF-${tag}`)],
      ] as const) {
        await p.reload();
        await p.locator('.ant-table-row').filter({ hasText: `DST-XFER-${tag}` }).filter({ hasText: side }).click();
        await expect(p.getByLabel('时间', { exact: true })).toHaveValue('02:30');
        await edit();
        await modal(p).getByRole('button', { name: btn('保存') }).click();
        await expect(p.locator('.ant-modal-wrap:visible')).toHaveCount(0);
        const both = await legs();
        expect(both).toHaveLength(2);
        for (const l of both) expect(l).toMatchObject({ occurredAt: '2026-03-08', occurredTime: '02:30', timeZone: 'Asia/Hong_Kong' });
      }
      expect((await legs()).map((l: any) => [l.note, l.referenceNumber])).toEqual([
        ['edited from the receiving side', `REF-${tag}`],
        ['edited from the receiving side', `REF-${tag}`],
      ]);

      // Clearing the time stores null — not 00:00 — and leaves the other details alone.
      await p.reload();
      await p.locator('.ant-table-row').filter({ hasText: `DST-${tag}-02:30` }).click();
      await p.getByLabel('时间', { exact: true }).fill('');
      await modal(p).getByRole('button', { name: btn('保存') }).click();
      await expect(p.locator('.ant-modal-wrap:visible')).toHaveCount(0);
      expect(await api('GET', `/transactions/${created[1]}`)).toMatchObject({ occurredTime: null, timeZone: 'Asia/Hong_Kong', purpose: `dst-${tag}` });
    } finally {
      for (const id of created) await api('DELETE', `/transactions/${id}`);
      await ctx.close();
    }
  });
}

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
