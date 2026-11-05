import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { OVERVIEW_TOTP_SECRET, OVERVIEW_USER } from './fixtures.ts';
import { accountIds, call, create, newKey, noHorizontalScroll, ownTransfer, signIn, spend } from './ledger-helpers.ts';

/**
 * M3-B5-B / B5-C browser journey: the overview (总览) as its own user, with fictional transactions
 * created through the API on FIXED past dates and the browser clock FIXED with page.clock — so the
 * result never depends on the day the suite runs (no year-end flakiness). The server only needs
 * these dates to be in its past.
 *
 * Covered: this year by default; presets on 31 December and 1 January, the last-month of a leap
 * February, a quarter switch, a month end, a custom range and "all"; the period in the URL across
 * reload, back and forward; per-currency cards with six rows; the undetermined block apart; the
 * server's distinct counts; pending → settlement in the app → confirmed without a reload; a void
 * disappears; several saved home regions; loading and error states; desktop / phone × dark / light
 * (no horizontal scroll, no clipped amount, readable contrast); no balance / asset / rate / total
 * wording; a clean console.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens-v1');
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** Browser "now" (Asia/Shanghai, the suite's time zone). */
const AT = {
  dec31: new Date('2025-12-31T23:30:00+08:00'),
  jan1: new Date('2026-01-01T00:10:00+08:00'),
  leapMarch: new Date('2024-03-10T12:00:00+08:00'),
  q3End: new Date('2025-09-30T20:00:00+08:00'),
  q4Start: new Date('2025-10-01T09:00:00+08:00'),
};

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
let allowServerErrors = false;
let acc: { hk: string; us: string; cn: string };
const tx: Record<string, string> = {};

const card = (block: string, currency: string) => page.locator(`.stat-card[data-block="${block}"][data-currency="${currency}"]`);
const row = (block: string, currency: string, key: string) => card(block, currency).locator(`[data-row="${key}"]`);
const metric = (name: string) => page.locator(`.metric-${name} .overview-metric-value`);
const section = (block: string) => page.locator(`section.overview-block[data-block="${block}"]`);
const selected = () => page.locator('.overview-period-presets .ant-segmented-item-selected');
const preset = (label: string) => page.locator('.overview-period-presets').getByText(label, { exact: true }).click();
const FORBIDDEN = /余额|资产|汇率|合计|总额|总计|≈|Balance|Total/i;

async function expectRow(block: string, currency: string, key: string, amount: string, count: string) {
  await expect(row(block, currency, key).locator('.stat-row-amount')).toHaveText(amount);
  await expect(row(block, currency, key).locator('.stat-row-count')).toHaveText(count);
}
/** Open the overview with the browser clock at `at`. */
async function openAt(at: Date, path = '/') {
  await page.clock.setFixedTime(at);
  await page.goto(path);
  await expect(page.locator('.overview-period')).toBeVisible();
}
const at = (date: string, body: Record<string, unknown>) => ({ ...body, occurredOn: date });

test.beforeAll(async ({ browser }) => {
  // page.clock fixes Date and performance.now, which would freeze the page-enter animation at
  // opacity 0; the app skips that animation for reduced motion (PanelLayout), so ask for it.
  context = await browser.newContext({ reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/the server responded with a status of 401/.test(m.text())) return; // the anonymous /auth/me probe
    if (allowServerErrors && /status of 500/.test(m.text())) return; // the provoked error state
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});
test.afterAll(async () => context.close());

test('an empty ledger on 31 December: this year by default, zero counts, empty blocks, nothing invented', async () => {
  await page.clock.setFixedTime(AT.dec31);
  await signIn(page, OVERVIEW_USER, OVERVIEW_TOTP_SECRET, '/');
  await expect(selected()).toHaveText('本年');
  await expect(page.locator('.overview-period-note')).toContainText('2025-01-01 至 2025-12-31');
  await expect(metric('transactions')).toHaveText('0');
  await expect(metric('pending')).toHaveText('0');
  await expect(metric('latest')).toHaveText('—');
  await expect(section('foreign').locator('.overview-block-empty')).toContainText('本期没有已确认金额的境外活动');
  await expect(section('undetermined').locator('.overview-block-empty')).toBeVisible();
  await expect(section('domestic')).toContainText('纯境内交易不在本产品的记录范围内');
  await expect(section('domestic').locator('.stat-card')).toHaveCount(0);
  await expect(page.locator('.overview-pending-none')).toBeVisible();
  await expect(page.locator('.overview-recent')).toContainText('本期没有流水');
  await expect(page.locator('#root')).not.toContainText(FORBIDDEN);
  await noHorizontalScroll(page);
  await shot(page, '89-overview-empty');
});

test('this year on 31 December: per-currency cards, the undetermined block, distinct counts, pending, several home regions', async () => {
  acc = await accountIds(page);
  const hk = (amount: number | null, direction: 'out' | 'in' = 'out') => ({ direction, accountId: acc.hk, currency: 'HKD', amount });
  const us = (amount: number | null) => ({ direction: 'out' as const, accountId: acc.us, currency: 'USD', amount });
  tx.spendHk = await create(page, at('2025-12-31', spend({ merchant: 'Harbour Gallery', country: 'US', currency: 'USD', amount: 1000, entry: hk(7830) })));
  tx.spendUs = await create(page, at('2025-12-30', spend({ merchant: 'Paris Bakery', country: 'FR', currency: 'EUR', amount: 1400, entry: us(1500) })));
  tx.refund = await create(page, { ...at('2025-12-29', spend({ merchant: 'Harbour Gallery', country: 'US', currency: 'HKD', amount: 2000, entry: hk(2000, 'in') })), type: 'merchant_refund' });
  tx.transfer = await create(page, at('2025-12-28', ownTransfer({ currency: 'HKD', amount: 100000, out: hk(100000), in: { direction: 'in', accountId: acc.us, currency: 'USD', amount: null } })));
  tx.monthEnd = await create(page, at('2025-11-30', spend({ merchant: 'Unknown Bookshop', country: null, currency: 'CNY', amount: 8800, entry: { direction: 'out', accountId: acc.cn, currency: 'CNY', amount: 8800 } })));
  tx.declared = await create(page, { ...at('2025-01-01', spend({ merchant: 'Mainland Tea House', country: 'CN', currency: 'CNY', amount: 4000, recordMode: 'backfill', entry: { direction: 'out', accountId: acc.cn, currency: 'CNY', amount: 4000 } })), declaredHomeRegion: 'HK' });
  tx.q3 = await create(page, at('2025-09-30', spend({ merchant: 'Quarter End Kiosk', country: 'US', currency: 'USD', amount: 300, entry: us(300) })));
  tx.q4 = await create(page, at('2025-10-01', spend({ merchant: 'Quarter Start Kiosk', country: 'US', currency: 'USD', amount: 400, entry: us(400) })));
  tx.big = await create(page, {
    ...at('2025-06-30', spend({ merchant: 'x', country: null, currency: 'USD', amount: 999999999999999, entry: us(999999999999999) })),
    type: 'third_party_transfer',
    merchantName: null,
    transferMethod: 'swift',
    counterparty: { name: 'Example Holdings', country: 'GB' },
  });
  tx.jan1 = await create(page, at('2026-01-01', spend({ merchant: 'New Year Cafe', country: 'US', currency: 'USD', amount: 110, entry: hk(1100) })));
  tx.leap = await create(page, at('2024-02-29', spend({ merchant: 'Leap Day Shop', country: 'US', currency: 'USD', amount: 220, recordMode: 'backfill', entry: hk(2200) })));
  await page.reload();

  // 2025 only: the 2026-01-01 and 2024-02-29 transactions are outside; one transaction has a pending amount.
  await expect(metric('transactions')).toHaveText('9');
  await expect(metric('pending')).toHaveText('1');
  await expect(page.locator('.metric-pending')).toContainText('1 项金额待补录');
  await expect(metric('latest')).toHaveText('2025-12-31');
  await expect(page.locator('.overview-home-regions')).toContainText('CN、HK');

  await expect(section('foreign').locator('.stat-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-currency')))).resolves.toEqual(['CNY', 'HKD', 'USD']);
  await expectRow('foreign', 'HKD', 'spend', '78.30', '1 笔');
  await expectRow('foreign', 'HKD', 'refund', '20.00', '1 笔'); // never netted against spending
  await expectRow('foreign', 'HKD', 'ownOut', '1,000.00', '1 笔');
  await expectRow('foreign', 'HKD', 'ownIn', '—', '—');
  await expectRow('foreign', 'USD', 'spend', '22.00', '3 笔'); // 15.00 + 3.00 + 4.00; event amounts never counted
  await expectRow('foreign', 'USD', 'ownIn', '—', '—'); // pending: not an amount, not zero
  await expectRow('foreign', 'USD', 'thirdOut', '9,999,999,999,999.99', '1 笔');
  await expectRow('foreign', 'CNY', 'spend', '40.00', '1 笔'); // judged by its declared home region HK
  await expect(section('undetermined')).toContainText('信息不足不等于境内');
  await expectRow('undetermined', 'CNY', 'spend', '88.00', '1 笔');

  await expect(page.locator('.overview-pending-summary')).toHaveText('1 笔交易中有 1 项金额待补录');
  await expect(page.locator('.pending-row')).toHaveCount(1);
  await expect(page.locator('.pending-row')).toContainText('本人调拨 · 到账');
  await expect(page.locator('.overview-recent .txn-card')).toHaveCount(5);
  await expect(page.locator('.overview-recent .txn-card').first()).toHaveAttribute('data-txn', tx.spendHk);
  await expect(page.locator('#root')).not.toContainText(FORBIDDEN);
});

test('details expand to the server groups behind a row', async () => {
  await card('foreign', 'HKD').locator('.stat-details-toggle').click();
  await expect(card('foreign', 'HKD').locator('.stat-detail')).toHaveCount(3);
  await expect(card('foreign', 'HKD').locator('.stat-detail').nth(0)).toContainText('商户：境外');
  await expect(card('foreign', 'HKD').locator('.stat-detail').nth(0)).toContainText('账户一侧：境外');
  await expect(card('foreign', 'HKD').locator('.stat-detail').nth(2)).toContainText('转账：境外跨法域');
  await card('foreign', 'HKD').locator('.stat-details-toggle').click();
  await expect(card('foreign', 'HKD').locator('.stat-detail')).toHaveCount(0);
});

test('pending → settlement in the app → the overview shows the confirmed amount without a reload', async () => {
  await page.locator('.overview-pending-open').click();
  await expect(page).toHaveURL(/\/transactions\?from=2025-01-01&to=2025-12-31&amountStatus=pending$/);
  await page.locator(`[data-txn="${tx.transfer}"]`).click();
  await page.locator('.txn-action-settle').click();
  const d = page.locator('.txn-settle-drawer');
  await d.getByLabel('补录金额 · in', { exact: true }).fill('128');
  await d.locator('.txn-submit').click();
  await expect(page.locator('.txn-head')).toContainText('当前版本 v2');
  await page.locator('.sider-nav .ant-menu-item', { hasText: '总览' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(metric('pending')).toHaveText('0');
  await expect(metric('transactions')).toHaveText('9');
  await expect(page.locator('.overview-pending-none')).toBeVisible();
  await expectRow('foreign', 'USD', 'ownIn', '128.00', '1 笔');
  await expectRow('foreign', 'HKD', 'ownOut', '1,000.00', '1 笔'); // the two sides stay apart
});

test('a voided transaction leaves the overview', async () => {
  expect((await call(page, 'POST', `/transactions/${tx.spendUs}/void`, { baseRevision: 1, reason: null }, newKey())).status).toBe(200);
  await page.reload();
  await expect(metric('transactions')).toHaveText('8');
  await expectRow('foreign', 'USD', 'spend', '7.00', '2 笔');
});

test('31 December: this month, last month (a month end), last year — reload, back and forward restore each', async () => {
  await openAt(AT.dec31);
  await preset('本月');
  await expect(page).toHaveURL(/\?period=month&from=2025-12-01&to=2025-12-31$/);
  await expect(metric('transactions')).toHaveText('3'); // 31st, 29th, 28th (the 30th is voided)
  await preset('上月');
  await expect(page).toHaveURL(/\?period=lastMonth&from=2025-11-01&to=2025-11-30$/);
  await expect(metric('transactions')).toHaveText('1'); // 30 November, the month's last day
  await expectRow('undetermined', 'CNY', 'spend', '88.00', '1 笔');
  await expect(section('foreign').locator('.overview-block-empty')).toBeVisible();
  await preset('上年');
  await expect(page).toHaveURL(/\?period=lastYear&from=2024-01-01&to=2024-12-31$/);
  await expect(metric('transactions')).toHaveText('1'); // 29 February 2024
  await expect(page.locator('.overview-home-regions')).toHaveCount(0);
  await page.reload();
  await expect(selected()).toHaveText('上年');
  await expect(metric('transactions')).toHaveText('1');
  await page.goBack();
  await expect(selected()).toHaveText('上月');
  await expect(metric('transactions')).toHaveText('1');
  await page.goBack();
  await expect(selected()).toHaveText('本月');
  await expect(metric('transactions')).toHaveText('3');
  await page.goForward();
  await expect(selected()).toHaveText('上月');
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(selected()).toHaveText('本年');
  await expect(metric('transactions')).toHaveText('8');
});

test('1 January: this year is the new year; last year, this month and last month cross the boundary', async () => {
  await openAt(AT.jan1);
  await expect(selected()).toHaveText('本年');
  await expect(page.locator('.overview-period-note')).toContainText('2026-01-01 至 2026-12-31');
  await expect(metric('transactions')).toHaveText('1');
  await expect(metric('latest')).toHaveText('2026-01-01');
  await preset('上年');
  await expect(page).toHaveURL(/\?period=lastYear&from=2025-01-01&to=2025-12-31$/);
  await expect(metric('transactions')).toHaveText('8');
  await preset('本月');
  await expect(page).toHaveURL(/\?period=month&from=2026-01-01&to=2026-01-31$/);
  await expect(metric('transactions')).toHaveText('1');
  await preset('上月');
  await expect(page).toHaveURL(/\?period=lastMonth&from=2025-12-01&to=2025-12-31$/);
  await expect(metric('transactions')).toHaveText('3');
  // A "this year" link made on 31 December keeps its own dates the next day (shown as custom).
  await openAt(AT.jan1, '/?period=year&from=2025-01-01&to=2025-12-31');
  await expect(selected()).toHaveText('自定义');
  await expect(metric('transactions')).toHaveText('8');
});

test('a quarter switch (30 September → 1 October) and the last month of a leap February', async () => {
  await openAt(AT.q3End);
  await preset('本季度');
  await expect(page).toHaveURL(/\?period=quarter&from=2025-07-01&to=2025-09-30$/);
  await expect(metric('transactions')).toHaveText('1'); // 30 September only
  await openAt(AT.q4Start);
  await preset('本季度');
  await expect(page).toHaveURL(/\?period=quarter&from=2025-10-01&to=2025-12-31$/);
  await expect(metric('transactions')).toHaveText('5'); // 1 October, 30 November, 28, 29, 31 December
  await openAt(AT.leapMarch);
  await preset('上月');
  await expect(page).toHaveURL(/\?period=lastMonth&from=2024-02-01&to=2024-02-29$/);
  await expect(page.locator('.overview-period-note')).toContainText('2024-02-01 至 2024-02-29');
  await expect(metric('transactions')).toHaveText('1');
  await expectRow('foreign', 'HKD', 'spend', '22.00', '1 笔');
});

test('a custom range and "all" survive a reload', async () => {
  await openAt(AT.dec31);
  await preset('自定义');
  const range = page.locator('.overview-period-range');
  await range.locator('input').first().click();
  await range.locator('input').first().fill('2025-12-28');
  await range.locator('input').nth(1).click();
  await range.locator('input').nth(1).fill('2025-12-31');
  await range.locator('input').nth(1).press('Enter');
  await expect(page).toHaveURL(/\?period=custom&from=2025-12-28&to=2025-12-31$/);
  await expect(metric('transactions')).toHaveText('3');
  await page.reload();
  await expect(selected()).toHaveText('自定义');
  await expect(page.locator('.overview-period-note')).toContainText('2025-12-28 至 2025-12-31');
  await expect(metric('transactions')).toHaveText('3');
  await preset('全部');
  await expect(page).toHaveURL(/\?period=all$/);
  await expect(page.locator('.overview-period-note')).toContainText('全部期间');
  await expect(metric('transactions')).toHaveText('10'); // 8 of 2025, 1 of 2026, 1 of 2024
  await page.reload();
  await expect(selected()).toHaveText('全部');
  await expect(metric('transactions')).toHaveText('10');
});

test('loading and error states', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/transactions/summary*', async (route) => {
    await held;
    await route.continue();
  });
  await openAt(AT.dec31, '/?period=lastYear');
  await expect(page.locator('.ant-skeleton')).toBeVisible();
  release();
  await expect(metric('transactions')).toHaveText('1');
  await page.unroute('**/api/transactions/summary*');

  allowServerErrors = true;
  await page.route('**/api/transactions/summary*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal error', code: 'INTERNAL' }) }));
  await openAt(AT.dec31, '/?period=month');
  await expect(page.locator('.ant-alert-error')).toBeVisible({ timeout: 20_000 }); // after the query's own retries
  await expect(page.locator('.overview-period')).toBeVisible(); // the period can still be changed
  await expect(page.locator('.stat-card')).toHaveCount(0); // no stale or invented numbers
  await page.unroute('**/api/transactions/summary*');
  allowServerErrors = false;
});

/** Contrast ratio of each matching element's text against the opaque background behind it (WCAG relative luminance). */
async function contrastOf(selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((els) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number);
    const over = (top: number[], bottom: number[]) => {
      const a = top[3] ?? 1;
      return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a));
    };
    const background = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if ((c[3] ?? 1) > 0) layers.push(c);
        if ((c[3] ?? 1) === 1) break;
      }
      let rgb = [255, 255, 255];
      for (const l of layers.reverse()) rgb = over(l, rgb);
      return rgb;
    };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o;
    };
    return els.map((el) => {
      if (opacity(el) < 0.99) return 0; // faded or invisible text is not readable text
      const bg = background(el);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    });
  });
}

for (const theme of ['dark', 'light'] as const) {
  for (const device of ['desktop', 'phone'] as const) {
    test(`visual: ${device} · ${theme} — no horizontal scroll, no clipped amount, readable text`, async () => {
      await page.setViewportSize(device === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await page.evaluate((m) => localStorage.setItem('xui-v1-theme', m), theme);
      await openAt(AT.dec31);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(metric('transactions')).toHaveText('8');
      if (device === 'phone') {
        await expect(page.locator('.overview-period-select')).toBeVisible();
        await expect(page.locator('.overview-period-presets')).toHaveCount(0);
      } else {
        await expect(page.locator('.overview-period-presets')).toBeVisible();
      }
      await card('foreign', 'HKD').locator('.stat-details-toggle').click();
      await expect(card('foreign', 'HKD').locator('.stat-detail')).toHaveCount(3);
      // The content is really painted (an unfinished enter animation once left it at opacity 0).
      await expect(page.locator('.content-area')).toHaveCSS('opacity', '1');
      await noHorizontalScroll(page);
      // Every amount and label is shown whole (nothing clipped or ellipsised).
      const clipped = await page
        .locator('.stat-row-amount, .stat-row-label, .stat-detail-label, .stat-currency, .overview-metric-value, .pending-row')
        .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis').map((e) => e.textContent));
      expect(clipped).toEqual([]);
      await expect(row('foreign', 'USD', 'thirdOut').locator('.stat-row-amount')).toHaveText('9,999,999,999,999.99');
      // Contrast: amounts, labels, counts, metrics and notes ≥ 4.5 (WCAG AA); de-emphasised empty rows ≥ 3.
      for (const [sel, min] of [
        ['.stat-row:not(.is-empty) .stat-row-amount', 4.5],
        ['.stat-row:not(.is-empty) .stat-row-label', 4.5],
        ['.overview-metric-value', 4.5],
        ['.stat-row:not(.is-empty) .stat-row-count', 4.5],
        ['.overview-block-note', 4.5],
        ['.overview-period-note', 4.5],
        ['.overview-domestic-note', 4.5],
        ['.overview-pending-note', 4.5],
        ['.overview-metric .field-note', 4.5],
        ['.stat-card-foot .field-note', 4.5],
        ['.overview-recent .field-note', 4.5],
        ['.stat-row.is-empty .stat-row-label', 3],
      ] as const) {
        const ratios = await contrastOf(sel);
        expect(ratios.length, sel).toBeGreaterThan(0);
        expect(Math.min(...ratios), `${theme} ${device} ${sel}`).toBeGreaterThanOrEqual(min);
      }
      await expect(page.locator('#root')).not.toContainText(FORBIDDEN);
      await shot(page, `9${device === 'desktop' ? 0 : 1}-overview-${device}-${theme}`);
    });
  }
}

test('no balance, asset, rate or total wording anywhere; the console stays clean', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.setItem('xui-v1-theme', 'dark'));
  for (const path of ['/', '/?period=all', '/?period=lastYear', '/?period=lastMonth']) {
    await openAt(AT.dec31, path);
    await expect(metric('transactions')).not.toHaveText('');
    await expect(page.locator('#root')).not.toContainText(FORBIDDEN);
  }
  expect(consoleErrors).toEqual([]);
});
