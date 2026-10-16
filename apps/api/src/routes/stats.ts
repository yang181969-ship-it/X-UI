import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { addMonths, INVEST_CATEGORY, statsQuerySchema, type StatsDto } from '@z-ui/shared';
import { accounts, trades, transactions, transactionTags } from '../db/schema.ts';
import { realizedSells, type RealizedSell, type TradeRow } from '../lib/invest.ts';
import type { AppBindings } from '../env.ts';
import { query } from '../lib/http.ts';

const income = sql<number>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.amount} else 0 end), 0)`;
const expense = sql<number>`coalesce(sum(case when ${transactions.type} = 'expense' then -${transactions.amount} else 0 end), 0)`;

/**
 * Income/expense statistics for one currency (no FX conversion): per month, per expense
 * category, per tag and per institution. Transfers and balance adjustments are excluded.
 */
export const statsRoutes = new Hono<AppBindings>().get('/', async (c) => {
  const q = query(c, statsQuerySchema);
  const { db } = c.var.deps;
  const userId = c.var.user.id;

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
  const base: SQL[] = [...scope, inArray(transactions.type, ['income', 'expense'])];

  const curRows = await db
    .select({ currency: transactions.currency, n: count() })
    .from(transactions)
    .where(and(...base))
    .groupBy(transactions.currency)
    .orderBy(desc(count()));
  const currencies = curRows.map((r) => r.currency);

  // Realized stock gains/losses (USD), counted on the sell date unless switched off; and the
  // money paid for / received from trades in the paying accounts (their cash legs).
  let sells: RealizedSell[] = [];
  const instOf = new Map<string, string>();
  const month = sql<string>`substr(${transactions.occurredAt}, 1, 7)`;
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
  if (flowRows.length && !currencies.includes('USD')) currencies.push('USD');
  if (q.invest !== '0') {
    const rows = (await db.select().from(trades).where(eq(trades.userId, userId))) as TradeRow[];
    sells = realizedSells(rows).filter((x) => x.date >= q.from && x.date <= q.to && (!q.accountId || x.accountId === q.accountId));
    if (sells.length) {
      for (const a of await db.select({ id: accounts.id, inst: accounts.institutionId }).from(accounts).where(eq(accounts.userId, userId))) instOf.set(a.id, a.inst);
      if (q.institutionId) sells = sells.filter((x) => x.accountId && instOf.get(x.accountId) === q.institutionId);
    }
    if (sells.length && !currencies.includes('USD')) currencies.push('USD');
  }

  const currency = q.currency ?? currencies[0] ?? null;
  const empty: StatsDto = { currencies, currency, totals: { income: 0, expense: 0, count: 0 }, months: [], byCategory: [], byTag: [], byInstitution: [], invest: null, stockFlows: null };
  if (!currency) return c.json(empty);

  const where = and(...base, eq(transactions.currency, currency))!;
  const isExpense = and(where, eq(transactions.type, 'expense'))!;

  const [[totals], monthRows, byCategory, byTag, byInstitution] = await Promise.all([
    db.select({ income, expense, count: count() }).from(transactions).where(where),
    db.select({ month, income, expense }).from(transactions).where(where).groupBy(month),
    db
      .select({ categoryId: transactions.categoryId, amount: expense, count: count() })
      .from(transactions)
      .where(isExpense)
      .groupBy(transactions.categoryId)
      .orderBy(desc(expense)),
    db
      .select({ tagId: transactionTags.tagId, amount: expense, count: count() })
      .from(transactions)
      .innerJoin(transactionTags, eq(transactionTags.transactionId, transactions.id))
      .where(isExpense)
      .groupBy(transactionTags.tagId)
      .orderBy(desc(expense)),
    db
      .select({ institutionId: accounts.institutionId, income, expense })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(where)
      .groupBy(accounts.institutionId)
      .orderBy(desc(expense)),
  ]);

  // Every month in the range, including empty ones, so the chart has no gaps.
  const months: StatsDto['months'] = [];
  for (let m = `${q.from.slice(0, 7)}-01`; m.slice(0, 7) <= q.to.slice(0, 7); m = addMonths(m, 1, 1)) {
    const r = monthRows.find((x) => x.month === m.slice(0, 7));
    months.push({ month: m.slice(0, 7), income: Number(r?.income ?? 0), expense: Number(r?.expense ?? 0) });
    if (months.length > 240) break;
  }

  const dto: StatsDto = {
    currencies,
    currency,
    totals: { income: Number(totals?.income ?? 0), expense: Number(totals?.expense ?? 0), count: totals?.count ?? 0 },
    months,
    byCategory: byCategory.map((r) => ({ categoryId: r.categoryId, amount: Number(r.amount), count: r.count })).filter((r) => r.amount !== 0),
    byTag: byTag.map((r) => ({ tagId: r.tagId, amount: Number(r.amount), count: r.count })).filter((r) => r.amount !== 0),
    byInstitution: byInstitution.map((r) => ({ institutionId: r.institutionId, income: Number(r.income), expense: Number(r.expense) })),
    invest: null,
    stockFlows: null,
  };

  if (currency === 'USD' && flowRows.length) {
    const sum = (rows: typeof flowRows, k: 'buy' | 'sell') => rows.reduce((a, r) => a + Number(r[k]), 0);
    const byAccount = new Map<string, { accountId: string; buy: number; sell: number }>();
    for (const r of flowRows) {
      const a = byAccount.get(r.accountId) ?? { accountId: r.accountId, buy: 0, sell: 0 };
      a.buy += Number(r.buy);
      a.sell += Number(r.sell);
      byAccount.set(r.accountId, a);
    }
    dto.stockFlows = {
      buy: sum(flowRows, 'buy'),
      sell: sum(flowRows, 'sell'),
      count: flowRows.reduce((a, r) => a + r.n, 0),
      months: dto.months.map((m) => {
        const rows = flowRows.filter((r) => r.month === m.month);
        return { month: m.month, buy: sum(rows, 'buy'), sell: sum(rows, 'sell') };
      }),
      byAccount: [...byAccount.values()].sort((a, b) => b.buy + b.sell - (a.buy + a.sell)),
    };
  }

  // Each sell's gain is income and each loss an expense (stocks are priced in USD).
  if (currency === 'USD' && sells.length) {
    const gain = sells.reduce((a, x) => a + Math.max(0, x.realized), 0);
    const loss = sells.reduce((a, x) => a + Math.max(0, -x.realized), 0);
    dto.invest = { gain, loss, sells: sells.length };
    dto.totals.income += gain;
    dto.totals.expense += loss;
    dto.totals.count += sells.length;
    for (const x of sells) {
      const m = dto.months.find((r) => r.month === x.date.slice(0, 7));
      if (m) {
        if (x.realized > 0) m.income += x.realized;
        else m.expense -= x.realized;
      }
      const inst = x.accountId ? instOf.get(x.accountId) : undefined;
      if (inst) {
        let row = dto.byInstitution.find((r) => r.institutionId === inst);
        if (!row) dto.byInstitution.push((row = { institutionId: inst, income: 0, expense: 0 }));
        if (x.realized > 0) row.income += x.realized;
        else row.expense -= x.realized;
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
