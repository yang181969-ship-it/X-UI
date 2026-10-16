// Time-sortable random ids (ULID-like, lowercase Crockford base32, 26 chars).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newId(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (const b of rand) r += ALPHABET[b % 32];
  return time + r;
}
