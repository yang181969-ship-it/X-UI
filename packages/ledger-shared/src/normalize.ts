/**
 * name_key (DATA_MODEL §1): NFKC → trim → runs of whitespace become one space → lower case.
 * "Wise", " wise " and "ＷＩＳＥ" (full-width) share one key. Used for duplicate checks
 * (institutions, payment channels) and search; the name itself is stored as entered.
 */
export function normalizeNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
