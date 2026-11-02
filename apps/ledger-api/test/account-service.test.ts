// Service layer for account PATCH (src/services/accounts.ts): the institution an account was
// opened with cannot be changed; the update can only contain schema fields.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accounts } from '../src/db/schema.ts';
import { accountPatchValues, IMMUTABLE_ACCOUNT_FIELDS, type AccountPatchColumns } from '../src/services/accounts.ts';
import { setup, type TestEnv } from './helpers.ts';

const NOW = 1_800_000_000_000;

describe('accountPatchValues', () => {
  it('refuses institutionId, alone or with other fields', () => {
    for (const body of [{ institutionId: 'other' }, { name: 'Renamed', institutionId: 'other' }, { institution_id: 'other' }, { accountCountry: 'LT', institutionId: null }]) {
      const r = accountPatchValues(body, NOW);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('VALIDATION');
        expect(r.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
      }
    }
  });

  it('refuses every other immutable field and an empty body', () => {
    for (const f of IMMUTABLE_ACCOUNT_FIELDS) expect(accountPatchValues({ [f]: 'x' }, NOW).ok, f).toBe(false);
    expect(accountPatchValues({}, NOW).ok).toBe(false);
  });

  it('maps the allowed fields to columns, recomputing name_key, and never to institution_id', () => {
    const r = accountPatchValues({ name: '  ＷＩＳＥ  Main ', accountCountry: 'LT', status: 'frozen', numberHint: '9876', notes: null }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual({ name: 'ＷＩＳＥ  Main', nameKey: 'wise main', accountCountry: 'LT', status: 'frozen', numberHint: '9876', notes: null, updatedAt: NOW });
    expect(Object.keys(r.values)).not.toContain('institutionId');
    // Type level: AccountPatchColumns has no institutionId.
    // @ts-expect-error institutionId is not a patchable column
    const impossible: AccountPatchColumns = { updatedAt: NOW, institutionId: 'x' };
    expect(impossible).toBeDefined();
  });
});

describe('account PATCH through the service on a real v1 database', () => {
  let t: TestEnv;
  beforeEach(async () => {
    t = await setup();
    const c = t.client;
    await c.execute("INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, created_at, updated_at) VALUES ('u1', 'u1', 'U1', 'admin', 'active', 'wa', 1, 1)");
    for (const [id, name] of [['wise-be', 'Wise Europe'], ['wise-gb', 'Wise UK']] as const) {
      await c.execute({ sql: "INSERT INTO institutions (id, user_id, name, name_key, institution_type, created_at, updated_at) VALUES (?, 'u1', ?, ?, 'emi', 1, 1)", args: [id, name, name.toLowerCase()] });
    }
    await c.execute(
      "INSERT INTO accounts (id, user_id, institution_id, name, name_key, account_type, account_country, created_at, updated_at) VALUES ('acc', 'u1', 'wise-be', 'Wise', 'wise', 'e_money', 'BE', 1, 1)",
    );
  });
  afterEach(() => t.cleanup());

  const row = async () => (await t.db.select().from(accounts).where(eq(accounts.id, 'acc')))[0]!;

  it('a valid patch updates the row and leaves the institution alone', async () => {
    const r = accountPatchValues({ name: 'Wise multi-currency', accountCountry: 'LT' }, NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    await t.db.update(accounts).set(r.values).where(eq(accounts.id, 'acc'));
    expect(await row()).toMatchObject({ institutionId: 'wise-be', name: 'Wise multi-currency', nameKey: 'wise multi-currency', accountCountry: 'LT', updatedAt: NOW });
  });

  it('the database refuses an institution change even when code bypasses the service (ORM update)', async () => {
    const err = await t.db
      .update(accounts)
      .set({ institutionId: 'wise-gb' })
      .where(eq(accounts.id, 'acc'))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const text = [err, (err as { cause?: unknown })?.cause].map((e) => String((e as Error)?.message ?? e)).join(' | ');
    expect(text).toMatch(/ACCOUNT_INSTITUTION_IMMUTABLE/);
    expect((await row()).institutionId).toBe('wise-be');
    await t.db.update(accounts).set({ name: 'Still fine', updatedAt: NOW }).where(eq(accounts.id, 'acc'));
    expect(await row()).toMatchObject({ name: 'Still fine', institutionId: 'wise-be' });
  });

  it('a patch that tries to move the account to another institution writes nothing', async () => {
    const before = await row();
    const r = accountPatchValues({ institutionId: 'wise-gb', name: 'Moved' }, NOW);
    expect(r.ok).toBe(false);
    expect(await row()).toEqual(before);
  });
});
