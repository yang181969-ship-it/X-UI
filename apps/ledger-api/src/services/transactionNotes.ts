import type { TransactionNotesDto } from '@xui/ledger-shared';
import { and, eq, gte } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { transactions } from '../db/schema.ts';

/**
 * PATCH /transactions/:id/notes (API_SPEC §5.9, P9): notes are no transaction fact. One UPDATE of
 * the header's notes and updated_at (tx_update_guard form ①, any status, voided included) — no
 * version, no event or entry, no idempotency key, no audit. Always written, the same value too
 * (updatedAt moves; no compare-then-write race); "" is kept as "", null clears. Last writer wins.
 * A single-statement batch (so tests can interleave other writes around it). Another user's, a
 * missing and an unpublished (current_revision 0) transaction update nothing → null (404).
 */
export async function updateNotes(c: { db: DB; userId: string; now: number }, id: string, notes: string | null): Promise<TransactionNotesDto | null> {
  const [rows] = await c.db.batch([
    c.db
      .update(transactions)
      .set({ notes, updatedAt: c.now })
      .where(and(eq(transactions.id, id), eq(transactions.userId, c.userId), gte(transactions.currentRevision, 1)))
      .returning({ id: transactions.id, notes: transactions.notes, updatedAt: transactions.updatedAt }),
  ]);
  return rows[0] ?? null;
}
