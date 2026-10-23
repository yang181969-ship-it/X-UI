import { expect } from 'vitest';
import { ARCHIVE_LINK_TYPES, type ArchiveRecordType, type TransactionType } from '@z-ui/shared';
import type { Deps } from '../src/env.ts';
import type { client } from './helpers.ts';
import { interleave } from './interleave.ts';
import type { Query } from './schema-check.ts';

/**
 * Links between historical records and transactions racing changes to those transactions.
 * Written once, run on libSQL (archive.test.ts) and on local D1 (d1.test.ts).
 */

type C = ReturnType<typeof client>;
type Res = { status: number; json: any };

export interface RaceContext {
  /** Signed-in user with accounts `cny` (CNY, opening 100 000) and `hkd` (HKD, opening 0). */
  a: C;
  /** Another signed-in user. */
  b: C;
  deps: Deps;
  q: Query;
  cny: string;
  hkd: string;
}

/**
 * Every linked or converted record that points at a missing transaction, another user's, one of
 * a type its kind doesn't allow, or a leg that isn't its entry's anchor (a transfer's sending leg).
 */
export async function linkProblems(q: Query): Promise<string[]> {
  const rows = await q(`select h.id, h.user_id as hu, h.record_type as rt, h.status, t.id as tid, t.user_id as tu, t.type, t.amount, t.transfer_group_id as tg
    from historical_records h left join transactions t on t.id = h.linked_transaction_id where h.status in ('linked', 'converted')`);
  const out: string[] = [];
  for (const r of rows) {
    const what = `${r['status']} ${r['rt']} record ${r['id']}`;
    if (!r['tid']) out.push(`${what}: transaction missing`);
    else if (r['tu'] !== r['hu']) out.push(`${what}: another user's transaction`);
    else if (!ARCHIVE_LINK_TYPES[r['rt'] as ArchiveRecordType].includes(r['type'] as TransactionType)) out.push(`${what}: linked to a ${r['type']} transaction`);
    else if (r['tg'] && Number(r['amount']) >= 0) out.push(`${what}: points at a transfer's receiving leg`);
  }
  return out;
}

const rec = async (x: RaceContext, b: Record<string, unknown>) => {
  const r = await x.a.post('/api/archive', b);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json;
};
const tx = async (x: RaceContext, b: Record<string, unknown>) => {
  const r = await x.a.post('/api/transactions', b);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json;
};
const get = async (x: RaceContext, id: string) => (await x.a.get(`/api/archive/${id}`)).json;
const balance = async (x: RaceContext, id: string, cur: string) => (await x.a.get(`/api/accounts/${id}`)).json.currencies.find((c: any) => c.currency === cur).balance as number;
const txCount = async (x: RaceContext) => Number((await x.q('select count(*) as n from transactions'))[0]!['n']);
/** `run`'s request, with `other` landing between its read and its write (same millisecond). */
const meanwhile = async (x: RaceContext, other: () => Promise<unknown>, run: () => Promise<Res>): Promise<Res> => {
  let res: Res | undefined;
  expect(await interleave(x.deps, other, async () => (res = await run()))).toBe(true);
  return res!;
};
const expense = (x: RaceContext, amount = 500) => ({ type: 'expense', accountId: x.cny, amount, occurredAt: '2026-02-01' });
const income = (x: RaceContext, amount = 500) => ({ type: 'income', accountId: x.cny, amount, occurredAt: '2026-02-01' });

export const LINK_RACES: [string, (x: RaceContext) => Promise<void>][] = [
  [
    'a link is refused when its transaction became incompatible just before the write',
    async (x) => {
      const e = await tx(x, expense(x));
      const r = await rec(x, { title: 'receipt', recordType: 'expense' });
      const n = await txCount(x);
      const res = await meanwhile(x, () => x.a.put(`/api/transactions/${e.id}`, income(x)), () => x.a.post(`/api/archive/${r.id}/link`, { transactionId: e.id }));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_TX_CHANGED']);
      expect(await get(x, r.id)).toMatchObject({ status: 'open', linkedTransactionId: null, version: 1 });
      expect((await x.a.get(`/api/transactions/${e.id}`)).json.type).toBe('income');
      expect(await txCount(x)).toBe(n);
      expect(await balance(x, x.cny, 'CNY')).toBe(100_000 + 500);
    },
  ],
  [
    'an edit of a linked record is refused when its transaction changed type just before the write',
    async (x) => {
      const e = await tx(x, expense(x));
      const r = await rec(x, { title: 'something' });
      await x.a.post(`/api/archive/${r.id}/link`, { transactionId: e.id });
      // The transaction becomes income (an unknown record fits that: it stays linked, untouched)
      // while the record is being changed to an expense record — which no longer fits.
      const res = await meanwhile(x, () => x.a.put(`/api/transactions/${e.id}`, income(x)), () => x.a.put(`/api/archive/${r.id}`, { title: 'something', recordType: 'expense' }));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_LINK_INCOMPATIBLE']);
      expect(await get(x, r.id)).toMatchObject({ recordType: 'unknown', status: 'linked', linkedTransactionId: e.id, version: 2 });
      // Read from the start: an unknown record linked to income can't become an expense record.
      const res2 = await x.a.put(`/api/archive/${r.id}`, { title: 'something', recordType: 'expense' });
      expect([res2.status, res2.json.code]).toEqual([409, 'ARCHIVE_LINK_INCOMPATIBLE']);
      expect((await x.a.put(`/api/archive/${r.id}`, { title: 'something', recordType: 'income' })).json).toMatchObject({ recordType: 'income', status: 'linked', version: 3 });
    },
  ],
  [
    'a transaction changed to a type its record does not fit releases a linked record, and is refused for a converted one',
    async (x) => {
      const e = await tx(x, expense(x));
      const linked = await rec(x, { title: 'linked', recordType: 'expense' });
      await x.a.post(`/api/archive/${linked.id}/link`, { transactionId: e.id });
      expect((await x.a.put(`/api/transactions/${e.id}`, income(x))).status).toBe(200);
      expect(await get(x, linked.id)).toMatchObject({ status: 'open', linkedTransactionId: null, version: 3 });

      const conv = await rec(x, { title: 'converted', recordType: 'expense', datePrecision: 'day', dateFrom: '2026-02-02', dateTo: '2026-02-02', amount: 700, currency: 'CNY', accountId: x.cny, verificationStatus: 'verified' });
      const txId = (await x.a.post(`/api/archive/${conv.id}/convert`)).json.linkedTransactionId;
      const before = await balance(x, x.cny, 'CNY');
      for (const change of [income(x, 700), { type: 'transfer', fromAccountId: x.cny, toAccountId: x.hkd, amount: 700, toAmount: 760, occurredAt: '2026-02-02' }]) {
        const res = await x.a.put(`/api/transactions/${txId}`, change);
        expect([res.status, res.json.code], change.type).toEqual([409, 'TX_FROM_ARCHIVE']);
      }
      // Rolled back whole: the transaction, the balances and the record are as they were.
      expect((await x.a.get(`/api/transactions/${txId}`)).json).toMatchObject({ type: 'expense', amount: -700, transferGroupId: null });
      expect(await balance(x, x.cny, 'CNY')).toBe(before);
      expect(await balance(x, x.hkd, 'HKD')).toBe(0);
      expect(await get(x, conv.id)).toMatchObject({ status: 'converted', linkedTransactionId: txId, version: 2 });
      // Edits that keep the type are fine.
      expect((await x.a.put(`/api/transactions/${txId}`, { ...expense(x, 900), occurredAt: '2026-02-02' })).status).toBe(200);
      expect(await balance(x, x.cny, 'CNY')).toBe(before - 200);
    },
  ],
  [
    'a link made after the type change reads the new type',
    async (x) => {
      const e = await tx(x, expense(x));
      await x.a.put(`/api/transactions/${e.id}`, income(x));
      const r = await rec(x, { title: 'receipt', recordType: 'expense' });
      expect((await x.a.post(`/api/archive/${r.id}/link`, { transactionId: e.id })).json.code).toBe('ARCHIVE_TYPE_MISMATCH');
      const u = await rec(x, { title: 'whatever' });
      expect((await x.a.post(`/api/archive/${u.id}/link`, { transactionId: e.id })).json).toMatchObject({ status: 'linked', linkedTransactionId: e.id });
    },
  ],
  [
    'concurrent links, record edits and type changes never leave an incompatible link',
    async (x) => {
      for (let i = 0; i < 6; i++) {
        const e = await tx(x, expense(x, 10 + i));
        const r = await rec(x, { title: `race ${i}`, recordType: 'expense' });
        const u = await rec(x, { title: `race unknown ${i}` });
        const requests = [
          () => x.a.post(`/api/archive/${r.id}/link`, { transactionId: e.id }),
          () => x.a.put(`/api/transactions/${e.id}`, income(x, 10 + i)),
          () => x.a.post(`/api/archive/${u.id}/link`, { transactionId: e.id }),
        ];
        if (i % 2) requests.reverse();
        const results = await Promise.all(requests.map((f) => f()));
        for (const res of results) expect([200, 400, 409], JSON.stringify(res.json)).toContain(res.status);
        // Whatever the order: the transaction is income and nothing points at it that doesn't fit.
        expect((await x.a.get(`/api/transactions/${e.id}`)).json.type).toBe('income');
        expect(await linkProblems(x.q)).toEqual([]);
        // An unknown record linked to it, edited into an expense record while it turns back into an expense.
        const fits = await get(x, u.id);
        if (fits.status === 'linked') {
          await Promise.all([x.a.put(`/api/archive/${u.id}`, { title: fits.title, recordType: 'income' }), x.a.put(`/api/transactions/${e.id}`, expense(x, 10 + i))]);
          expect(await linkProblems(x.q)).toEqual([]);
        }
      }
    },
  ],
  [
    'a transfer is linked through its sending leg, and a link to a transfer that went away is refused',
    async (x) => {
      const xfer = await tx(x, { type: 'transfer', fromAccountId: x.cny, toAccountId: x.hkd, amount: 1000, toAmount: 1080, occurredAt: '2026-02-03' });
      const legs = (await x.a.get('/api/transactions?type=transfer&pageSize=200')).json.items.filter((l: any) => l.transferGroupId === xfer.transferGroupId);
      const inLeg = legs.find((l: any) => l.amount > 0);
      const r = await rec(x, { title: 'wire', recordType: 'transfer' });
      // Edited meanwhile, still a transfer: the sending leg keeps its id and is linked.
      const transfer = { type: 'transfer', fromAccountId: x.cny, toAccountId: x.hkd, amount: 1000, toAmount: 1090, occurredAt: '2026-02-03' };
      const ok = await meanwhile(x, () => x.a.put(`/api/transactions/${inLeg.id}`, transfer), () => x.a.post(`/api/archive/${r.id}/link`, { transactionId: inLeg.id }));
      expect(ok.status).toBe(200);
      expect(ok.json.linkedTransactionId).toBe(xfer.id);
      expect(ok.json.linkedTransactions.map((l: any) => l.amount)).toEqual([-1000, 1090]);

      // Edited meanwhile into an expense from its receiving side: the sending leg is gone.
      const y = await tx(x, { ...transfer, amount: 200, toAmount: 216 });
      const yIn = (await x.a.get('/api/transactions?type=transfer&pageSize=200')).json.items.find((l: any) => l.transferGroupId === y.transferGroupId && l.amount > 0);
      const w = await rec(x, { title: 'wire 2', recordType: 'transfer' });
      const n = await txCount(x);
      const gone = await meanwhile(x, () => x.a.put(`/api/transactions/${yIn.id}`, { type: 'expense', accountId: x.hkd, amount: 216, occurredAt: '2026-02-03' }), () =>
        x.a.post(`/api/archive/${w.id}/link`, { transactionId: yIn.id }),
      );
      expect([gone.status, gone.json.code]).toEqual([409, 'ARCHIVE_TX_CHANGED']);
      expect(await get(x, w.id)).toMatchObject({ status: 'open', linkedTransactionId: null, version: 1 });
      expect(await txCount(x)).toBe(n - 1);
    },
  ],
  [
    'a refused link changes no version, status, row or balance, and never reaches another user',
    async (x) => {
      const theirs = (await x.b.get('/api/accounts')).json[0]?.id as string;
      const theirTx = (await x.b.post('/api/transactions', { type: 'expense', accountId: theirs, amount: 5, occurredAt: '2026-02-04' })).json;
      const r = await rec(x, { title: 'mine', recordType: 'expense' });
      const n = await txCount(x);
      const before = await balance(x, x.cny, 'CNY');
      expect((await x.a.post(`/api/archive/${r.id}/link`, { transactionId: theirTx.id })).status).toBe(404);
      const e = await tx(x, expense(x));
      const res = await meanwhile(x, () => x.a.del(`/api/transactions/${e.id}`), () => x.a.post(`/api/archive/${r.id}/link`, { transactionId: e.id }));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_TX_CHANGED']);
      expect(await get(x, r.id)).toMatchObject({ status: 'open', linkedTransactionId: null, version: 1 });
      expect(await txCount(x)).toBe(n);
      expect(await balance(x, x.cny, 'CNY')).toBe(before);
      expect((await x.b.get(`/api/transactions/${theirTx.id}`)).json).toMatchObject({ amount: -5 });
    },
  ],
];
