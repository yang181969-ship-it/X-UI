import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { addMonths, currencyDecimals, INVEST_CATEGORY, statsQuerySchema, summaryCurrency, type StatsDto } from '@z-ui/shared';
import { accounts, fxRates, trades, transactions, transactionTags } from '../db/schema.ts';
import { realizedSells, type RealizedSell, type TradeRow } from '../lib/invest.ts';
import type { AppBindings } from '../env.ts';
import { query } from '../lib/http.ts';
import { convert } from './fx.ts';

const income = sql<number>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.amount} else 0 end), 0)`;
const expense = sql<number>`coalesce(sum(case when ${transactions.type} = 'expense' then -${transactions.amount} else 0 end), 0)`;

/**
 * Income/expense statistics per month, expense category, tag and institution. Transfers and
 * balance adjustments are excluded. Every query is grouped by currency; the result is either one
 * currency (`currency=XXX`) or — by default — all currencies converted to one (`convertTo`, else
 * the configured summary currency) with the last synced FX rates. Currencies without a rate are left
 * out of the converted view and listed in `missing`.
 */
export const statsRoutes = new Hono<AppBindings>().get('/', async (c) => {
  const q = query(c, statsQuerySchema);
  const { db, config } = c.var.deps;
  const userId = c.var.user.id;
  const cfg = config.get();

  // Date range + account/institution filter, shared by income/expense and the stock cash legs.
  const scope: SQL[] = [eq(transactions.userId, userId), gte(transactions.occurredAt, q.from), lte(transactions.occurredAt, q.to)];
  if (q.accountId) scope.push(eq(transactions.accountId, q.accountId));
  if (q.institutionId) {
    scope.push(
      inArray(
        transactions.accountId,
        sql`(select ${accounts.id} from ${accounts} where ${accounts.institutionId} = ${q.institutionId} and ${accounts.userId} = ${userId})`,
      ),
    );
  }
  const where = and(...scope, inArray(transactions.type, ['income', 'expense']))!;
  const isExpense = and(where, eq(transactions.type, 'expense'))!;
  const month = sql<string>`substr(${transactions.occurredAt}, 1, 7)`;
  const cur = transactions.currency;

  const [totalRows, monthRows, catRows, tagRows, instRows, rates] = await Promise.all([
    db.select({ cur, income, expense, n: count() }).from(transactions).where(where).groupBy(cur).orderBy(desc(count())),
    db.select({ cur, month, income, expense }).from(transactions).where(where).groupBy(month, cur),
    db.select({ cur, categoryId: transactions.categoryId, amount: expense, n: count() }).from(transactions).where(isExpense).groupBy(transactions.categoryId, cur),
    db
      .select({ cur, tagId: transactionTags.tagId, amount: expense, n: count() })
      .from(transactions)
      .innerJoin(transactionTags, eq(transactionTags.transactionId, transactions.id))
      .where(isExpense)
      .groupBy(transactionTags.tagId, cur),
    db
      .select({ cur, institutionId: accounts.institutionId, income, expense })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(where)
      .groupBy(accounts.institutionId, cur),
    db.select().from(fxRates),
  ]);
  const currencies = totalRows.map((r) => r.cur);

  // Stocks (USD): realized gain/loss of each sell on its date unless switched off, and the money
  // paid for / received from trades in the paying accounts (their cash legs).
  let sells: RealizedSell[] = [];
  const instOf = new Map<string, string>();
  const flowRows =
    q.invest === '0'
      ? []
      : await db
          .select({
            accountId: transactions.accountId,
            month,
            buy: sql<number>`coalesce(sum(case when ${transactions.amount} < 0 then -${transactions.amount} else 0 end), 0)`,
            sell: sql<number>`coalesce(sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end), 0)`,
            n: count(),
          })
          .from(transactions)
          .where(and(...scope, eq(transactions.type, 'trade'), eq(transactions.currency, 'USD')))
          .groupBy(transactions.accountId, month);
  if (q.invest !== '0') {
    const rows = (await db.select().from(trades).where(eq(trades.userId, userId))) as TradeRow[];
    sells = realizedSells(rows).filter((x) => x.date >= q.from && x.date <= q.to && (!q.accountId || x.accountId === q.accountId));
    if (sells.length) {
      for (const a of await db.select({ id: accounts.id, inst: accounts.institutionId }).from(accounts).where(eq(accounts.userId, userId))) instOf.set(a.id, a.inst);
      if (q.institutionId) sells = sells.filter((x) => x.accountId && instOf.get(x.accountId) === q.institutionId);
    }
  }
  if ((sells.length || flowRows.length) && !currencies.includes('USD')) currencies.push('USD');

  // One currency, or everything converted to the target currency.
  const convertTo = q.convertTo && cfg.currencies.some((x) => x.code === q.convertTo) ? q.convertTo : summaryCurrency(cfg);
  const single = q.currency ?? null;
  const target = single ?? convertTo;
  const perUsd = new Map(rates.map((r) => [r.currency, r.perUsd]));
  const decimals = (code: string) => currencyDecimals(cfg, code);
  const to = (amount: number, from: string): number | null =>
    single ? (from === single ? amount : null) : convert(amount, from, target, perUsd, decimals);
  const missing = single ? [] : currencies.filter((x) => to(1, x) === null);
  const ok = (code: string) => !missing.includes(code) && (!single || code === single);
  const conv = (amount: number | string, from: string) => to(Number(amount), from) ?? 0;

  const totals = { income: 0, expense: 0, count: 0 };
  for (const r of totalRows.filter((x) => ok(x.cur))) {
    totals.income += conv(r.income, r.cur);
    totals.expense += conv(r.expense, r.cur);
    totals.count += r.n;
  }

  // Every month in the range, including empty ones, so the chart has no gaps.
  const months: StatsDto['months'] = [];
  for (let m = `${q.from.slice(0, 7)}-01`; m.slice(0, 7) <= q.to.slice(0, 7); m = addMonths(m, 1, 1)) {
    const key = m.slice(0, 7);
    const rows = monthRows.filter((x) => x.month === key && ok(x.cur));
    months.push({ month: key, income: rows.reduce((a, r) => a + conv(r.income, r.cur), 0), expense: rows.reduce((a, r) => a + conv(r.expense, r.cur), 0) });
    if (months.length > 240) break;
  }

  const merge = <K extends string | null, R extends { cur: string; n: number; amount: number | string }>(rows: R[], key: (r: R) => K) => {
    const map = new Map<K, { amount: number; count: number }>();
    for (const r of rows.filter((x) => ok(x.cur))) {
      const v = map.get(key(r)) ?? { amount: 0, count: 0 };
      v.amount += conv(r.amount, r.cur);
      v.count += r.n;
      map.set(key(r), v);
    }
    return [...map].filter(([, v]) => v.amount !== 0).sort((a, b) => b[1].amount - a[1].amount);
  };
  const inst = new Map<string, { institutionId: string; income: number; expense: number }>();
  for (const r of instRows.filter((x) => ok(x.cur))) {
    const v = inst.get(r.institutionId) ?? { institutionId: r.institutionId, income: 0, expense: 0 };
    v.income += conv(r.income, r.cur);
    v.expense += conv(r.expense, r.cur);
    inst.set(r.institutionId, v);
  }

  const dto: StatsDto = {
    currencies,
    currency: single,
    convertedTo: single ? null : target,
    missing,
    totals,
    months,
    byCategory: merge(catRows, (r) => r.categoryId).map(([categoryId, v]) => ({ categoryId, amount: v.amount, count: v.count })),
    byTag: merge(tagRows, (r) => r.tagId).map(([tagId, v]) => ({ tagId, amount: v.amount, count: v.count })),
    byInstitution: [...inst.values()].sort((a, b) => b.expense - a.expense),
    invest: null,
    stockFlows: null,
  };

  // Stock figures are USD: shown in the USD view, or converted in the combined view.
  const usd = (n: number) => to(n, 'USD');
  if (flowRows.length && usd(1) !== null) {
    const sum = (rows: typeof flowRows, k: 'buy' | 'sell') => rows.reduce((a, r) => a + Number(r[k]), 0);
    const byAccount = new Map<string, { accountId: string; buy: number; sell: number }>();
    for (const r of flowRows) {
      const a = byAccount.get(r.accountId) ?? { accountId: r.accountId, buy: 0, sell: 0 };
      a.buy += Number(r.buy);
      a.sell += Number(r.sell);
      byAccount.set(r.accountId, a);
    }
    dto.stockFlows = {
      buy: usd(sum(flowRows, 'buy'))!,
      sell: usd(sum(flowRows, 'sell'))!,
      count: flowRows.reduce((a, r) => a + r.n, 0),
      months: dto.months.map((m) => {
        const rows = flowRows.filter((r) => r.month === m.month);
        return { month: m.month, buy: usd(sum(rows, 'buy'))!, sell: usd(sum(rows, 'sell'))! };
      }),
      byAccount: [...byAccount.values()].map((a) => ({ ...a, buy: usd(a.buy)!, sell: usd(a.sell)! })).sort((a, b) => b.buy + b.sell - (a.buy + a.sell)),
    };
  }

  // Each sell's gain is income and each loss an expense.
  if (sells.length && usd(1) !== null) {
    const gain = sells.reduce((a, x) => a + Math.max(0, usd(x.realized)!), 0);
    const loss = sells.reduce((a, x) => a + Math.max(0, -usd(x.realized)!), 0);
    dto.invest = { gain, loss, sells: sells.length };
    dto.totals.income += gain;
    dto.totals.expense += loss;
    dto.totals.count += sells.length;
    for (const x of sells) {
      const v = usd(x.realized)!;
      const m = dto.months.find((r) => r.month === x.date.slice(0, 7));
      if (m) {
        if (v > 0) m.income += v;
        else m.expense -= v;
      }
      const instId = x.accountId ? instOf.get(x.accountId) : undefined;
      if (instId) {
        let row = dto.byInstitution.find((r) => r.institutionId === instId);
        if (!row) dto.byInstitution.push((row = { institutionId: instId, income: 0, expense: 0 }));
        if (v > 0) row.income += v;
        else row.expense -= v;
      }
    }
    if (loss) {
      dto.byCategory.push({ categoryId: INVEST_CATEGORY, amount: loss, count: sells.filter((x) => x.realized < 0).length });
      dto.byCategory.sort((a, b) => b.amount - a.amount);
    }
    dto.byInstitution.sort((a, b) => b.expense - a.expense);
  }
  return c.json(dto);
});
