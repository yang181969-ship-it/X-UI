import type { Context } from 'hono';
import { auditLog } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { newId } from './id.ts';

export type AuditAction =
  | 'login.success'
  | 'login.failure'
  | 'login.locked'
  | 'logout'
  | 'step_up'
  | 'passkey.add'
  | 'passkey.remove'
  | 'password.change'
  | 'totp.rebind'
  | 'recovery.regenerate'
  | 'recovery.used'
  | 'session.revoke'
  | 'invite.accept'
  // M2 (API_SPEC §3.7): detail holds ids (and card last4) only — home_region changes hold the two region codes.
  | 'institution.delete'
  | 'account.delete'
  | 'card.create'
  | 'card.delete'
  | 'card_link.create'
  | 'card_link.end'
  | 'card_link.delete'
  | 'channel.delete'
  | 'preferences.home_region'
  // M3 (API_SPEC §5.11): written by the financial write chain itself (services/transactionWrite.ts), never by audit().
  | 'transaction.create'
  | 'transaction.correct'
  | 'transaction.void';

export async function audit(
  c: Context<AppBindings>,
  action: AuditAction,
  detail: Record<string, unknown> | null = null,
  userId: string | null = c.get('user')?.id ?? null,
) {
  await c.var.deps.db.insert(auditLog).values({
    id: newId(),
    userId,
    action,
    detail,
    ip: c.var.ip,
    createdAt: c.var.deps.now(),
  });
}
