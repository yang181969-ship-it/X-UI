import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  addDays,
  daysInMonth,
  diffDays,
  dismissReminderSchema,
  fromParts,
  maskPan,
  nextDayOfMonth,
  type ReminderDto,
} from '@z-ui/shared';
import { accountCurrencies, accounts, billOccurrences, bills, cards, creditStatements, reminderDismissals } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { body } from '../lib/http.ts';
import { syncOccurrences, today } from './bills.ts';
import { statementDtos } from './statements.ts';

/**
 * In-app reminders, computed on request from bills, statements and cards:
 *  - bill occurrences that are pending
 *  - statements with an unpaid remainder
 *  - credit card due days with no statement entered yet
 *  - cards about to expire
 *  - credit accounts over their limit
 */
export async function computeReminders(deps: Deps, userId: string): Promise<ReminderDto[]> {
  const { db } = deps;
  const cfg = deps.config.get().reminders;
  const t = today(deps);
  const horizon = addDays(t, cfg.lookaheadDays);
  await syncOccurrences(deps, userId, horizon);

  const out: ReminderDto[] = [];
  const push = (r: Omit<ReminderDto, 'daysLeft' | 'severity'>, soonDays: number) => {
    const daysLeft = diffDays(r.date, t);
    out.push({ ...r, daysLeft, severity: daysLeft < 0 ? 'overdue' : daysLeft <= soonDays ? 'soon' : 'upcoming' });
  };

  const occ = await db
    .select({ o: billOccurrences, b: bills })
    .from(billOccurrences)
    .innerJoin(bills, eq(bills.id, billOccurrences.billId))
    .where(and(eq(billOccurrences.userId, userId), eq(billOccurrences.status, 'pending'), lte(billOccurrences.dueDate, horizon)));
  for (const { o, b } of occ) {
    push({ key: `bill:${o.id}`, kind: 'bill', title: b.name, date: o.dueDate, amount: o.amount, currency: b.currency, refId: o.id }, b.remindDaysBefore);
  }

  const stRows = await db
    .select()
    .from(creditStatements)
    .where(and(eq(creditStatements.userId, userId), lte(creditStatements.dueDate, horizon), gte(creditStatements.dueDate, addDays(t, -120))));
  const statements = await statementDtos(deps, userId, stRows);
  const cardRows = await db.select().from(cards).where(and(eq(cards.userId, userId), eq(cards.archived, false)));
  const cardName = (id: string) => {
    const cd = cardRows.find((x) => x.id === id);
    return cd ? (cd.nickname ?? maskPan(cd.last4)) : '';
  };
  for (const s of statements) {
    if (s.remaining <= 0) continue;
    push(
      { key: `statement:${s.id}`, kind: 'statement', title: cardName(s.cardId), date: s.dueDate, amount: s.remaining, currency: s.currency, refId: s.id },
      cfg.defaultDaysBefore,
    );
  }

  for (const cd of cardRows) {
    if (cd.funding === 'credit' && cd.dueDay) {
      const due = nextDayOfMonth(t, cd.dueDay);
      // Banks shift due dates around weekends/holidays, so a statement within ±5 days counts.
      const entered = stRows.some((s) => s.cardId === cd.id && Math.abs(diffDays(s.dueDate, due)) <= 5);
      if (due <= horizon && !entered) {
        push(
          { key: `card_due:${cd.id}:${due}`, kind: 'card_due', title: cd.nickname ?? maskPan(cd.last4), date: due, amount: null, currency: null, refId: cd.id },
          cfg.defaultDaysBefore,
        );
      }
    }
    if (cd.expMonth && cd.expYear) {
      const expiry = fromParts(cd.expYear, cd.expMonth, daysInMonth(cd.expYear, cd.expMonth));
      if (diffDays(expiry, t) <= cfg.cardExpiryDays && diffDays(expiry, t) >= -31) {
        push(
          { key: `card_expiry:${cd.id}:${cd.expYear}-${cd.expMonth}`, kind: 'card_expiry', title: cd.nickname ?? maskPan(cd.last4), date: expiry, amount: null, currency: null, refId: cd.id },
          cfg.cardExpiryDays,
        );
      }
    }
  }

  // Credit accounts owing more than their limit (primary currency). Keyed per day: dismissing
  // hides it until tomorrow, and it comes back while the account is still over the limit.
  const credit = await db
    .select({ a: accounts, balance: accountCurrencies.balance })
    .from(accounts)
    .innerJoin(accountCurrencies, and(eq(accountCurrencies.accountId, accounts.id), eq(accountCurrencies.currency, accounts.currency)))
    .where(and(eq(accounts.userId, userId), eq(accounts.type, 'credit'), eq(accounts.archived, false), isNotNull(accounts.creditLimit)));
  for (const { a, balance } of credit) {
    const owed = -balance;
    if (!a.creditLimit || owed <= a.creditLimit) continue;
    out.push({
      key: `over_limit:${a.id}:${t}`,
      kind: 'over_limit',
      title: a.name,
      date: t,
      daysLeft: 0,
      amount: owed - a.creditLimit,
      currency: a.currency,
      refId: a.id,
      severity: 'overdue',
    });
  }

  const dismissed = new Set(
    (await db.select({ key: reminderDismissals.key }).from(reminderDismissals).where(eq(reminderDismissals.userId, userId))).map((d) => d.key),
  );
  return out.filter((r) => !dismissed.has(r.key)).sort((a, b) => a.date.localeCompare(b.date));
}

export const reminderRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json(await computeReminders(c.var.deps, c.var.user.id)))

  .post('/dismiss', async (c) => {
    const { key } = await body(c, dismissReminderSchema);
    await c.var.deps.db
      .insert(reminderDismissals)
      .values({ userId: c.var.user.id, key, dismissedAt: c.var.deps.now() })
      .onConflictDoNothing();
    return c.json({ ok: true });
  });
