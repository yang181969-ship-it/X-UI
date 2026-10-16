import { eq } from 'drizzle-orm';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import QRCode from 'qrcode';
import { passwordSchema, usernameSchema } from '@z-ui/shared';
import { generateTotpSecret, totpUri } from '../auth/totp.ts';
import { checkTotp, createUser, regenerateRecoveryCodes } from '../auth/users.ts';
import { DEFAULT_CONFIG } from '../config/defaults.ts';
import { DbConfigStore } from '../config/store.ts';
import { openLibsql } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { readEnv, type Deps } from '../env.ts';
import { defaultDbUrl, loadDotEnv } from '../node.ts';

/**
 * Bootstrap an administrator from the terminal. There is no sign-up page: the first admin is
 * created here, everyone else is invited from the web UI.
 */

let muted = false;
const out = new Writable({
  write(chunk, encoding, cb) {
    if (!muted) process.stdout.write(chunk, encoding);
    cb();
  },
});
const rl = createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY ?? false });

async function ask(question: string, hidden = false): Promise<string> {
  process.stdout.write(question);
  muted = hidden;
  const answer = await rl.question('');
  muted = false;
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

/** Ask until `check` accepts the answer (returns null) or print its error and ask again. */
async function askValid(question: string, check: (s: string) => string | null, hidden = false): Promise<string> {
  for (;;) {
    const answer = await ask(question, hidden);
    const error = check(answer);
    if (error === null) return answer;
    console.log(`  ✗ ${error}`);
  }
}

async function main() {
  loadDotEnv();
  const env = readEnv(process.env);
  const db = await openLibsql(process.env.DATABASE_URL ?? defaultDbUrl());
  const config = new DbConfigStore(db, DEFAULT_CONFIG);
  await config.load();
  const deps: Deps = { db, env, config, now: Date.now };

  console.log('\n  Z-UI — create administrator\n');
  const admins = await db.select().from(users).where(eq(users.role, 'admin'));
  if (admins.some((a) => a.status === 'active')) {
    const yes = await ask(`  An admin already exists (${admins.map((a) => a.username).join(', ')}). Create another? [y/N] `);
    if (yes.toLowerCase() !== 'y') return;
  }

  const username = usernameSchema.parse(
    await askValid('  Username: ', (s) => {
      const r = usernameSchema.safeParse(s);
      return r.success ? null : (r.error.issues[0]?.message ?? 'invalid');
    }),
  );
  const [taken] = await db.select().from(users).where(eq(users.username, username));
  if (taken) {
    console.log(`  ✗ "${username}" already exists`);
    return;
  }
  const displayName = (await ask('  Display name: ')) || username;
  let password = '';
  for (;;) {
    password = await askValid('  Password (≥ 10 chars): ', (s) => (passwordSchema.safeParse(s).success ? null : 'at least 10 characters'), true);
    if ((await ask('  Repeat password: ', true)) === password) break;
    console.log('  ✗ passwords do not match');
  }

  const secret = generateTotpSecret();
  const user = await createUser(deps, { username, displayName, password, role: 'admin', status: 'pending', totpSecret: secret });
  let activated = false;
  try {
    const uri = totpUri(secret, username, env.RP_NAME);
    console.log('\n  Scan with Google Authenticator (or any TOTP app):\n');
    console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
    console.log(`  Or enter the key manually: ${secret}\n`);
    for (let attempt = 0; attempt < 5 && !activated; attempt++) {
      const code = await ask('  6-digit code from the app: ');
      if (/^\d{6}$/.test(code) && (await checkTotp(deps, user, code))) activated = true;
      else console.log('  ✗ incorrect code (check the phone clock)');
    }
    if (!activated) {
      console.log('\n  Aborted.');
      return;
    }
    await db.update(users).set({ status: 'active', totpEnabled: true, updatedAt: Date.now() }).where(eq(users.id, user.id));
    const codes = await regenerateRecoveryCodes(deps, user.id);
    console.log('\n  ✓ Administrator created.\n');
    console.log('  Recovery codes — store them offline; each works once if you lose your phone:\n');
    for (let i = 0; i < codes.length; i += 2) console.log(`    ${codes[i]}    ${codes[i + 1] ?? ''}`);
    console.log('\n  Next: npm run dev → http://localhost:5173 → sign in with password + code,');
    console.log('  then add a passkey under 安全 (Security).\n');
  } finally {
    if (!activated) await db.delete(users).where(eq(users.id, user.id));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
