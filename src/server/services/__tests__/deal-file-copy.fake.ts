/**
 * A `$queryRaw` implementation that answers the deal-file use check (`assertNotDealFileImages`) as
 * "a delivery file's copy" only when that check was bound with `id`, so a site that checks a
 * different row than the one it attaches is seen. Every other raw query goes to `otherwise`, or
 * gets `[]`.
 */
export const dealCopyCheckFor = (
  id: number,
  otherwise?: (strings: TemplateStringsArray, ...values: unknown[]) => unknown
) =>
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('').includes('ServiceDealFile') &&
    values.some((value) => Array.isArray(value) && value.includes(id))
      ? [{ dealFileImage: true }]
      : otherwise?.(strings, ...values) ?? []) as never;
