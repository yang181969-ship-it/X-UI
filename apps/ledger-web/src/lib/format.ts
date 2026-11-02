export function initials(name: string) {
  const s = name.trim();
  if (!s) return '?';
  // Latin names get two letters ("HS"), CJK names one character.
  return /^[a-z0-9]/i.test(s) ? s.slice(0, 2).toUpperCase() : s.slice(0, 1);
}

/** Stable pleasant color for an avatar when none is set. */
export function colorFor(seed: string) {
  const palette = ['#1677ff', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#52c41a', '#2f54eb', '#faad14', '#08979c', '#f5222d'];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}
