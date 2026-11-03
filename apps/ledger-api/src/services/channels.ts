import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { auditLog, paymentChannels, paymentChannelSources } from '../db/schema.ts';
import { insertIfInstitutionActive, rowAsSelect, type Batch } from './accounts.ts';
import type { AuditEntry } from './cards.ts';

/**
 * Payment channel rules (API_SPEC §3.6, DATA_MODEL §3.6, §3.7). A channel is where a payment is
 * started (a device wallet, a payment service, …); it holds no money and has no balance. Its
 * sources are the cards or accounts behind it. Every multi-statement write is one db.batch() — a
 * single transaction on libsql and on D1 — and each rule is checked by the statement that writes,
 * so a concurrent change makes a write do nothing (the route then re-reads and answers 404 / 400 /
 * 409), never half of it:
 * - a provider must be an active institution of the user's (INSERT … SELECT / UPDATE … EXISTS);
 * - an account source is only for channels that are not device wallets (INSERT … SELECT from the
 *   channel), and a channel with account sources can't become a device wallet (UPDATE … NOT EXISTS);
 * - at most one default source per channel: "set default" clears the channel's other default and
 *   sets the new one in the same batch, in that order, both only while the target is (still)
 *   active (the partial unique index payment_channel_sources_default_uq is the last line of defence);
 * - ownership, the balance account's type and its single use, one active record per source and
 *   the card-or-account XOR are the database's own: composite foreign keys, the
 *   BALANCE_ACCOUNT_KIND triggers, partial unique indexes and CHECKs.
 * Only channel.delete is audited (API_SPEC §3.7), from the row in the same batch as the delete.
 */

export type ChannelRow = Required<typeof paymentChannels.$inferInsert>;
export type SourceRow = Required<typeof paymentChannelSources.$inferInsert>;
type Key = { id: string; userId: string };

const ownChannel = (k: Key, ...more: (SQL | undefined)[]) => and(eq(paymentChannels.id, k.id), eq(paymentChannels.userId, k.userId), ...more);
const ownSource = (k: Key, ...more: (SQL | undefined)[]) => and(eq(paymentChannelSources.id, k.id), eq(paymentChannelSources.userId, k.userId), ...more);

/** The institution is an active one of the user's (correlated subqueries are written by hand: drizzle renders outer columns unqualified). */
export const activeProvider = (institutionId: string, userId: string) =>
  sql`EXISTS (SELECT 1 FROM institutions i WHERE i.id = ${institutionId} AND i.user_id = ${userId} AND i.status = 'active')`;

/** The channel being updated has no account source of any status (a device wallet is funded by cards only). */
export const noAccountSources = sql`NOT EXISTS (SELECT 1 FROM payment_channel_sources s WHERE s.user_id = "payment_channels"."user_id" AND s.channel_id = "payment_channels"."id" AND s.account_id IS NOT NULL)`;

/**
 * POST /payment-channels. With a provider: INSERT … SELECT from that institution while it is an
 * active one of the user's, so an archived (or another user's, or missing) provider writes nothing;
 * without one, a plain INSERT. Balance account rules are the database's (foreign key, trigger,
 * unique index): a violation fails the statement.
 */
export function channelInsert(db: DB, row: ChannelRow) {
  return row.providerInstitutionId ? insertIfInstitutionActive(db, paymentChannels, row, row.providerInstitutionId) : db.insert(paymentChannels).values(row);
}

/** INSERT INTO audit_log … SELECT … FROM payment_channels WHERE (this channel, this user): detail { id } — never the name or notes. */
export function channelAuditStatement(db: DB, action: 'channel.delete', channel: Key, entry: AuditEntry) {
  const row = {
    id: sql`${entry.id}`.as('id'),
    userId: sql`${channel.userId}`.as('user_id'),
    action: sql`${action}`.as('action'),
    detail: sql`json_object('id', ${paymentChannels.id})`.as('detail'),
    ip: sql`${entry.ip}`.as('ip'),
    createdAt: sql`${entry.now}`.as('created_at'),
  } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>;
  return db.insert(auditLog).select(db.select(row).from(paymentChannels).where(ownChannel(channel)));
}

/**
 * DELETE /payment-channels/:id: the audit record (read from the row, so only while it exists), then
 * the delete, which cascades to the channel's sources (ended ones too) in the same statement. The
 * cards, accounts and balance account stay. From M3, a channel used by a transaction is refused
 * (NO ACTION) and the audit record rolls back with it.
 */
export function channelDeleteBatch(db: DB, channel: Key, audit: AuditEntry): Batch {
  return [channelAuditStatement(db, 'channel.delete', channel, audit), db.delete(paymentChannels).where(ownChannel(channel)).returning({ id: paymentChannels.id })];
}

/**
 * Make `source` its channel's default: clear the channel's other default, then set this one (with
 * any `also` columns, e.g. notes). Both only act while the source is (still, inside the
 * transaction) an active source of the user's; otherwise neither changes anything and the caller
 * sees zero rows from the second. A source's channel never changes.
 */
export function sourceDefaultStatements(db: DB, source: Key & { channelId: string }, now: number, also: Partial<SourceRow> = {}) {
  const eligible = sql`EXISTS (SELECT 1 FROM payment_channel_sources t WHERE t.id = ${source.id} AND t.user_id = ${source.userId} AND t.status = 'active')`;
  return [
    db
      .update(paymentChannelSources)
      .set({ isDefault: false, updatedAt: now })
      .where(
        and(
          eq(paymentChannelSources.userId, source.userId),
          eq(paymentChannelSources.channelId, source.channelId),
          eq(paymentChannelSources.isDefault, true),
          ne(paymentChannelSources.id, source.id),
          eligible,
        ),
      ),
    db
      .update(paymentChannelSources)
      .set({ ...also, isDefault: true, updatedAt: now })
      .where(ownSource(source, eq(paymentChannelSources.status, 'active')))
      .returning({ id: paymentChannelSources.id }),
  ] as const;
}

/**
 * POST /payment-channels/:id/sources: INSERT … SELECT from the channel while it is the user's —
 * and, for an account source, not a device wallet — so a channel that is missing, another user's,
 * deleted or turned into a device wallet in between writes nothing. A card or account of another
 * user (or deleted in between) fails its composite foreign key; a second active record of the same
 * source fails the partial unique index. Then, if asked, set-default (which only acts if the new
 * row exists).
 */
export function sourceCreateBatch(db: DB, row: SourceRow, makeDefault: boolean): Batch {
  const channel = and(eq(paymentChannels.id, row.channelId), eq(paymentChannels.userId, row.userId), row.accountId !== null ? ne(paymentChannels.channelType, 'device_wallet') : undefined);
  const insert = db
    .insert(paymentChannelSources)
    .select(
      db
        .select(rowAsSelect(paymentChannelSources, { ...row, isDefault: false }))
        .from(paymentChannels)
        .where(channel) as never,
    );
  return [insert, ...(makeDefault ? sourceDefaultStatements(db, row, row.createdAt) : [])];
}

/** POST /payment-channel-sources/:id/end: only while active — ending twice changes nothing. Ending clears the default (the CHECK allows defaults on active sources only). */
export function sourceEndStatement(db: DB, source: Key, now: number) {
  return db
    .update(paymentChannelSources)
    .set({ status: 'ended', isDefault: false, updatedAt: now })
    .where(ownSource(source, eq(paymentChannelSources.status, 'active')))
    .returning({ id: paymentChannelSources.id });
}

/** PATCH /payment-channel-sources/:id without making it the default: notes and / or clearing the flag (any status). */
export function sourceUpdateStatement(db: DB, source: Key, values: Partial<SourceRow>) {
  return db.update(paymentChannelSources).set(values).where(ownSource(source)).returning({ id: paymentChannelSources.id });
}

/** DELETE /payment-channel-sources/:id (correcting mistakes): the record only — never the card or account. */
export function sourceDeleteStatement(db: DB, source: Key) {
  return db.delete(paymentChannelSources).where(ownSource(source)).returning({ id: paymentChannelSources.id });
}
