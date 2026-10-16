import { and, asc, count, desc, eq, gte, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  dashboardQuerySchema,
  monthEnd,
  monthStart,
  type CurrencyTotal,
  type DashboardCountryNode,
  type DashboardDto,
} from '@z-ui/shared';
import { currencyDecimals } from '@z-ui/shared';
import { accounts, cards, fxRates, institutions, transactions } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { listAccountsWithBalance } from './accounts.ts';
import { today } from './bills.ts';
import { convert } from './fx.ts';
import { investDto } from './invest.ts';
import { query } from '../lib/http.ts';
import { listedTx, sumsByCurrency, toDtos } from './transactions.ts';

export const dashboardRoutes = new Hono<AppBindings>().get('/', async (c) => {
  const { db } = c.var.deps;
  const userId = c.var.user.id;
  const t = today(c.var.deps);

  const q = query(c, dashboardQuerySchema);
  const investP = investDto(db, userId);
  const [accs, insts, recentRows, month, [cardCount], rates, invest] = await Promise.all([
    listAccountsWithBalance(db, userId, eq(accounts.archived, false), investP),
    db
      .select()
      .from(institutions)
      .where(and(eq(institutions.userId, userId), eq(institutions.archived, false)))
      .orderBy(asc(institutions.sort), asc(institutions.createdAt)),
    db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), listedTx(userId)))
      .orderBy(desc(transactions.occurredAt), desc(transactions.createdAt))
      .limit(10),
    sumsByCurrency(db, and(eq(transactions.userId, userId), gte(transactions.occurredAt, monthStart(t)), lte(transactions.occurredAt, monthEnd(t)))!),
    db.select({ n: count() }).from(cards).where(and(eq(cards.userId, userId), eq(cards.archived, false))),
    db.select().from(fxRates),
    investP,
  ]);

  // Per-currency totals; no FX conversion — each currency is summed on its own.
  // Balances switched off with "include in totals" are left out.
  const totals = new Map<string, CurrencyTotal>();
  for (const a of accs) {
    for (const cur of a.currencies) {
      if (!cur.includeInTotal) continue;
      const tot = totals.get(cur.currency) ?? { currency: cur.currency, assets: 0, liabilities: 0, net: 0, accountCount: 0 };
      if (cur.balance >= 0) tot.assets += cur.balance;
      else tot.liabilities += -cur.balance;
      tot.net += cur.balance;
      tot.accountCount++;
      totals.set(cur.currency, tot);
    }
  }

  // Country → institution → account tree.
  const tree: DashboardCountryNode[] = [];
  for (const inst of insts) {
    const children = accs.filter((a) => a.institutionId === inst.id);
    if (children.length === 0) continue;
    let node = tree.find((n) => n.country === inst.country);
    if (!node) tree.push((node = { country: inst.country, institutions: [] }));
    node.institutions.push({
      id: inst.id,
      name: inst.name,
      type: inst.type,
      color: inst.color,
      accounts: children.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        balances: a.currencies.map((cur) => ({ currency: cur.currency, balance: cur.balance })),
        creditUsage: a.creditUsage,
        holdings: a.investment?.marketValue ?? null,
        stockCash: a.stockCash,
      })),
    });
  }

  // Net worth in the chosen currency (default: the app's), using the last synced exchange rates.
  const cfg = c.var.deps.config.get();
  const base = q.currency && cfg.currencies.some((x) => x.code === q.currency) ? q.currency : cfg.app.defaultCurrency;
  const perUsd = new Map(rates.map((r) => [r.currency, r.perUsd]));
  const decimals = (code: string) => currencyDecimals(cfg, code);
  const visible = [...totals.values()].filter((x) => x.assets !== 0 || x.liabilities !== 0);
  const missing = visible.filter((x) => convert(1, x.currency, base, perUsd, decimals) === null).map((x) => x.currency);
  const conv = (currency: string, v: number) => convert(v, currency, base, perUsd, decimals) ?? 0;
  // Stocks in an account are already in its USD balance; only positions without one (or whose
  // account holds no USD) are added here. Archived accounts stay out, like their cash.
  const listed = new Map(accs.map((a) => [a.id, a]));
  const unattached = invest.holdings
    .filter((h) => !h.accountId || (listed.has(h.accountId) && !listed.get(h.accountId)!.currencies.some((x) => x.currency === 'USD')))
    .reduce((a, h) => a + (h.marketValue ?? 0), 0);
  const investValue = unattached ? conv('USD', unattached) : 0;
  const converted = rates.length
    ? {
        currency: base,
        assets: visible.reduce((a, x) => a + conv(x.currency, x.assets), 0) + investValue,
        liabilities: visible.reduce((a, x) => a + conv(x.currency, x.liabilities), 0),
        net: visible.reduce((a, x) => a + conv(x.currency, x.net), 0) + investValue,
        asOf: rates.reduce<string | null>((a, r) => (a && a > r.asOf ? a : r.asOf), null),
        missing: unattached && !missing.includes('USD') && convert(1, 'USD', base, perUsd, decimals) === null ? [...missing, 'USD'] : missing,
      }
    : null;

  const dto: DashboardDto = {
    // Currencies whose balances are all zero are not shown.
    totals: visible.sort((a, b) => b.accountCount - a.accountCount),
    converted,
    investments: invest.holdings.length
      ? { marketValue: invest.totals.marketValue, unrealized: invest.totals.unrealized, positions: invest.holdings.length }
      : null,
    tree,
    recent: await toDtos(db, userId, recentRows),
    month,
    counts: { institutions: insts.length, accounts: accs.length, cards: cardCount?.n ?? 0 },
  };
  return c.json(dto);
});
