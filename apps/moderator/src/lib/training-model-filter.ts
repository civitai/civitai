const MAX_INT4 = 2_147_483_647;

/** Model ids start at 1, so 0 matches no row. */
export const NO_MODEL = 0;

/** `undefined` means not filtering; an unusable id must return NO_MODEL, or the link widens to the whole feed. */
export function parseModelIdFilter(raw: string): number | undefined {
  if (!raw) return undefined;
  if (!/^\d{1,10}$/.test(raw)) return NO_MODEL;
  const id = Number(raw);
  return id > 0 && id <= MAX_INT4 ? id : NO_MODEL;
}
