// `Image.blockedFor` is a comma list of block reasons; a CSAM block is CSAM anywhere in it, in any case.

/** Whether `blockedFor`, an SQL expression, names CSAM. NULL reads false. */
export function csamInBlockedForSql(blockedFor: string): string {
  return `EXISTS (
      SELECT 1 FROM unnest(string_to_array(${blockedFor}, ',')) AS mw_reason(value)
      WHERE lower(btrim(mw_reason.value)) = 'csam'
    )`;
}

/** `csamInBlockedForSql` for a value already read. Trims spaces only, as `btrim` does. */
export function blockedForNamesCsam(blockedFor: string | null | undefined): boolean {
  return !!blockedFor
    ?.split(',')
    .some((reason) => reason.replace(/^ +| +$/g, '').toLowerCase() === 'csam');
}
