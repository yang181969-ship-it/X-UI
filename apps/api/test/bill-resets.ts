import { expect } from 'vitest';
import type { Deps } from '../src/env.ts';
import type { client } from './helpers.ts';
import { interleave } from './interleave.ts';
import type { Query } from './schema-check.ts';

/**
 * Undoing a bill payment deletes the whole entry it became — both legs of a transfer included —
 * in one guarded batch. Written once, run on libSQL (archive.test.ts) and on local D1 (d1.test.ts).
 */

type C = ReturnType<typeof client>;
type Res = { status: number; json: any };

export interface ResetContext {
  /** Signed-in user with `cny` (CNY 100 000), `hkd` (HKD 0) and `multi` (CNY 50 000 + USD 10 000). */
  a: C;
  deps: Deps;
  q: Query;
  cny: string;
  hkd: string;
  multi: string;
}

/** The user's transfer groups that don't have exactly two legs (a stray or a missing leg). */
export async function strayLegs(x: ResetContext): Promise<string[]> {
  const userId = (await x.a.get('/api/auth/me')).json.user.id as string;
  const rows = await x.q(`select transfer_group_id as g, count(*) as n from transactions where user_id = '${userId}' and transfer_group_id is not null group by transfer_group_id having count(*) <> 2`);
  return rows.map((r) => `group ${r['g']}: ${r['n']} legs`);
}

/** Every balance and transaction count of every account of the user. */
const balances = async (x: ResetContext) =>
  (await x.a.get('/api/accounts')).json.map((a: any) => [a.id, a.currencies.map((c: any) => [c.currency, c.balance, c.transactionCount])]);
const balance = async (x: ResetContext, id: string, cur: string) => (await x.a.get(`/api/accounts/${id}`)).json.currencies.find((c: any) => c.currency === cur).balance as number;
const count = async (x: ResetContext, where: string) => Number((await x.q(`select count(*) as n from ${where}`))[0]!['n']);
const legsOf = async (x: ResetContext, group: string) => count(x, `transactions where transfer_group_id = '${group}'`);
const tagLinks = async (x: ResetContext, ids: string[]) => count(x, `transaction_tags where transaction_id in (${ids.map((i) => `'${i}'`).join(', ')})`);
const occurrence = async (x: ResetContext, billId: string) => (await x.a.get('/api/bills/occurrences')).json.find((o: any) => o.billId === billId);
const record = async (x: ResetContext, id: string) => (await x.a.get(`/api/archive/${id}`)).json;
const transferLegs = async (x: ResetContext, group: string) =>
  (await x.a.get('/api/transactions?type=transfer&pageSize=200')).json.items.filter((l: any) => l.transferGroupId === group) as any[];
const reset = (x: ResetContext, occId: string) => x.a.post(`/api/bills/occurrences/${occId}/reset`);
const meanwhile = async (x: ResetContext, other: () => Promise<unknown>, run: () => Promise<Res>): Promise<Res> => {
  let res: Res | undefined;
  expect(await interleave(x.deps, other, async () => (res = await run()))).toBe(true);
  return res!;
};

let bills = 0;
/** A one-time bill of 300 (CNY, from `cny`) due in the past: recorded as paid with an expense. */
async function paidBill(x: ResetContext) {
  const bill = (await x.a.post('/api/bills', { name: `Rent ${++bills}`, kind: 'once', amount: 300, currency: 'CNY', accountId: x.cny, startDate: '2026-10-01', pastPolicy: 'record' })).json;
  const occ = await occurrence(x, bill.id);
  expect(occ).toMatchObject({ status: 'paid' });
  expect(occ.transactionId).toBeTruthy();
  return { billId: bill.id as string, occId: occ.id as string, txId: occ.transactionId as string };
}
/** Edit the payment into a transfer; returns its legs (sending leg first). */
async function intoTransfer(x: ResetContext, txId: string, b: Record<string, unknown>) {
  const res = await x.a.put(`/api/transactions/${txId}`, { type: 'transfer', amount: 300, occurredAt: '2026-10-01', ...b });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const group = res.json.transferGroupId as string;
  const legs = (await transferLegs(x, group)).sort((p, q) => p.amount - q.amount);
  expect(legs).toHaveLength(2);
  return { group, from: legs[0], to: legs[1] };
}

export const BILL_RESETS: [string, (x: ResetContext) => Promise<void>][] = [
  [
    'undoing a plain payment deletes its expense, as before',
    async (x) => {
      const before = await balances(x);
      const p = await paidBill(x);
      expect(await balance(x, x.cny, 'CNY')).toBe(100_000 - 300);
      const res = await reset(x, p.occId);
      expect([res.status, res.json]).toEqual([200, { ok: true, deleted: 1 }]);
      expect(await count(x, `transactions where id = '${p.txId}'`)).toBe(0);
      expect(await occurrence(x, p.billId)).toMatchObject({ status: 'pending', transactionId: null });
      expect(await balances(x)).toEqual(before);
    },
  ],
  [
    'undoing a payment edited into a transfer deletes both legs, their tags, and releases its record — which then converts once',
    async (x) => {
      const before = await balances(x);
      const p = await paidBill(x);
      const tag = (await x.a.post('/api/tags', { name: `bill-tag-${bills}` })).json.id;
      const t = await intoTransfer(x, p.txId, { fromAccountId: x.cny, toAccountId: x.multi, fromCurrency: 'CNY', toCurrency: 'CNY', tagIds: [tag] });
      expect(t.from.id).toBe(p.txId);
      expect(await tagLinks(x, [t.from.id, t.to.id])).toBe(2);
      expect(await balance(x, x.multi, 'CNY')).toBe(50_000 + 300);
      const r = (await x.a.post('/api/archive', { title: 'rent wire', recordType: 'transfer', datePrecision: 'day', dateFrom: '2026-10-01', dateTo: '2026-10-01', amount: 300, currency: 'CNY', fromAccountId: x.cny, toAccountId: x.multi, toCurrency: 'CNY', verificationStatus: 'verified' })).json;
      // Linked through the receiving leg: points at the sending one.
      expect((await x.a.post(`/api/archive/${r.id}/link`, { transactionId: t.to.id })).json).toMatchObject({ status: 'linked', linkedTransactionId: t.from.id, version: 2 });

      const res = await reset(x, p.occId);
      expect([res.status, res.json]).toEqual([200, { ok: true, deleted: 2 }]);
      // Both legs gone, with their tag links; the occurrence is unpaid; every balance as before the bill.
      expect(await legsOf(x, t.group)).toBe(0);
      expect(await tagLinks(x, [t.from.id, t.to.id])).toBe(0);
      expect(await occurrence(x, p.billId)).toMatchObject({ status: 'pending', transactionId: null });
      expect(await balances(x)).toEqual(before);
      const released = await record(x, r.id);
      expect(released).toMatchObject({ status: 'open', linkedTransactionId: null, linkedTransactions: [], version: 3 });
      expect(released.linkLostAt).toEqual(expect.any(Number));

      // Converted again: one transfer, received once (+300, not +600).
      const conv = (await x.a.post(`/api/archive/${r.id}/convert`)).json;
      expect(conv.linkedTransactions.map((l: any) => [l.accountId, l.amount])).toEqual([
        [x.cny, -300],
        [x.multi, 300],
      ]);
      expect(await legsOf(x, conv.linkedTransactions[0].transferGroupId)).toBe(2);
      expect(await balance(x, x.multi, 'CNY')).toBe(50_000 + 300);
      expect(await balance(x, x.cny, 'CNY')).toBe(100_000 - 300);
    },
  ],
  [
    'cross-currency and same-account exchange payments are undone whole too',
    async (x) => {
      const before = await balances(x);
      const p1 = await paidBill(x);
      const t1 = await intoTransfer(x, p1.txId, { fromAccountId: x.cny, toAccountId: x.hkd, fromCurrency: 'CNY', toCurrency: 'HKD', toAmount: 330 });
      expect(await balance(x, x.hkd, 'HKD')).toBe(330);
      const p2 = await paidBill(x);
      const t2 = await intoTransfer(x, p2.txId, { fromAccountId: x.multi, toAccountId: x.multi, fromCurrency: 'CNY', toCurrency: 'USD', toAmount: 40 });
      expect(await balance(x, x.multi, 'USD')).toBe(10_040);
      for (const [p, t] of [
        [p1, t1],
        [p2, t2],
      ] as const) {
        expect((await reset(x, p.occId)).json).toEqual({ ok: true, deleted: 2 });
        expect(await legsOf(x, t.group)).toBe(0);
      }
      expect(await balances(x)).toEqual(before);
    },
  ],
  [
    'an incomplete transfer is refused, never undone halfway',
    async (x) => {
      // A receiving leg gone (damaged data), and a group with a third leg.
      const p1 = await paidBill(x);
      const t1 = await intoTransfer(x, p1.txId, { fromAccountId: x.cny, toAccountId: x.multi, toCurrency: 'CNY' });
      await x.q(`delete from transactions where id = '${t1.to.id}'`);
      const p2 = await paidBill(x);
      const t2 = await intoTransfer(x, p2.txId, { fromAccountId: x.cny, toAccountId: x.multi, toCurrency: 'CNY' });
      await x.q(`insert into transactions (id, user_id, account_id, type, amount, currency, occurred_at, transfer_group_id, extra, created_at, updated_at)
        select 'extra-' || id, user_id, account_id, type, amount, currency, occurred_at, transfer_group_id, extra, created_at, updated_at from transactions where id = '${t2.to.id}'`);
      const before = await balances(x);
      const rows = await count(x, 'transactions');
      for (const [p, group, legs] of [
        [p1, t1.group, 1],
        [p2, t2.group, 3],
      ] as const) {
        const res = await reset(x, p.occId);
        expect([res.status, res.json.code]).toEqual([409, 'TX_GROUP_INVALID']);
        expect(await legsOf(x, group)).toBe(legs);
        expect(await occurrence(x, p.billId)).toMatchObject({ status: 'paid', transactionId: p.txId });
      }
      expect(await count(x, 'transactions')).toBe(rows);
      expect(await balances(x)).toEqual(before);
      // Cleaned up on the transactions page, which deletes whatever legs the group has.
      for (const p of [p1, p2]) expect((await x.a.del(`/api/transactions/${p.txId}`)).status).toBe(200);
      expect(await strayLegs(x)).toEqual([]);
    },
  ],
  [
    'an undo racing other changes is refused whole, or carries them along — never half',
    async (x) => {
      // (a) The payment becomes a transfer while being undone: a new leg the undo didn't read.
      const pa = await paidBill(x);
      const toTransfer = { type: 'transfer', fromAccountId: x.cny, toAccountId: x.multi, toCurrency: 'CNY', amount: 300, occurredAt: '2026-10-01' };
      let res = await meanwhile(x, () => x.a.put(`/api/transactions/${pa.txId}`, toTransfer), () => reset(x, pa.occId));
      expect([res.status, res.json.code]).toEqual([409, 'TX_CHANGED']);
      const groupA = (await x.a.get(`/api/transactions/${pa.txId}`)).json.transferGroupId;
      expect(await legsOf(x, groupA)).toBe(2);
      expect(await occurrence(x, pa.billId)).toMatchObject({ status: 'paid', transactionId: pa.txId });
      // Undone again, now as what it is: both legs go.
      expect((await reset(x, pa.occId)).json).toEqual({ ok: true, deleted: 2 });

      // (b) A leg moves to another currency meanwhile: refused, nothing written.
      const pb = await paidBill(x);
      const tb = await intoTransfer(x, pb.txId, { fromAccountId: x.cny, toAccountId: x.multi, toCurrency: 'CNY' });
      res = await meanwhile(x, () => x.a.put(`/api/transactions/${tb.to.id}`, { ...toTransfer, toCurrency: 'USD', toAmount: 40 }), () => reset(x, pb.occId));
      expect([res.status, res.json.code]).toEqual([409, 'TX_CHANGED']);
      expect(await legsOf(x, tb.group)).toBe(2);
      expect(await balance(x, x.multi, 'USD')).toBe(10_040);
      expect((await reset(x, pb.occId)).json).toEqual({ ok: true, deleted: 2 });

      // (c) A record is linked meanwhile: the undo goes through and releases it in the same batch.
      const pc = await paidBill(x);
      const tc = await intoTransfer(x, pc.txId, { fromAccountId: x.cny, toAccountId: x.multi, toCurrency: 'CNY' });
      const r = (await x.a.post('/api/archive', { title: 'raced', recordType: 'transfer' })).json;
      res = await meanwhile(x, () => x.a.post(`/api/archive/${r.id}/link`, { transactionId: tc.to.id }), () => reset(x, pc.occId));
      expect(res.json).toEqual({ ok: true, deleted: 2 });
      expect(await legsOf(x, tc.group)).toBe(0);
      expect(await record(x, r.id)).toMatchObject({ status: 'open', linkedTransactionId: null, version: 3 });

      // (d) The bill is deleted meanwhile (its payment stays as an ordinary expense): refused.
      const pd = await paidBill(x);
      const beforeD = await balances(x);
      res = await meanwhile(x, () => x.a.del(`/api/bills/${pd.billId}`), () => reset(x, pd.occId));
      expect([res.status, res.json.code]).toEqual([409, 'TX_CHANGED']);
      expect((await x.a.get(`/api/transactions/${pd.txId}`)).json).toMatchObject({ amount: -300, billOccurrenceId: null });
      expect(await balances(x)).toEqual(beforeD);

      // (e) The payment is deleted on the transactions page meanwhile: that already undid it.
      const pe = await paidBill(x);
      res = await meanwhile(x, () => x.a.del(`/api/transactions/${pe.txId}`), () => reset(x, pe.occId));
      expect([res.status, res.json.code]).toEqual([409, 'TX_CHANGED']);
      expect(await occurrence(x, pe.billId)).toMatchObject({ status: 'pending', transactionId: null });
      expect(await count(x, `transactions where id = '${pe.txId}'`)).toBe(0);
      expect(await strayLegs(x)).toEqual([]);
    },
  ],
  [
    'deleting on the transactions page also refuses an entry that changed meanwhile',
    async (x) => {
      const e = (await x.a.post('/api/transactions', { type: 'expense', accountId: x.cny, amount: 50, occurredAt: '2026-10-02' })).json;
      const res = await meanwhile(
        x,
        () => x.a.put(`/api/transactions/${e.id}`, { type: 'transfer', fromAccountId: x.cny, toAccountId: x.hkd, amount: 50, toAmount: 55, occurredAt: '2026-10-02' }),
        () => x.a.del(`/api/transactions/${e.id}`),
      );
      expect([res.status, res.json.code]).toEqual([409, 'TX_CHANGED']);
      const group = (await x.a.get(`/api/transactions/${e.id}`)).json.transferGroupId;
      expect(await legsOf(x, group)).toBe(2);
      expect((await x.a.del(`/api/transactions/${e.id}`)).json).toEqual({ ok: true, deleted: 2 });
      expect(await strayLegs(x)).toEqual([]);
    },
  ],
];
