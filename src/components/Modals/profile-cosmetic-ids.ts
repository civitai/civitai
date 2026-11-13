/**
 * The cosmetic id to send for a slot the editor only sends when it changed: undefined leaves the slot
 * alone, null unequips it. Sending null on every save would query the slot's type even for someone
 * who never had one, which fails while that enum value is not applied yet.
 */
export function changedCosmeticId(
  current: { id: number } | null | undefined,
  previous: { id: number } | null | undefined
) {
  if ((current?.id ?? null) === (previous?.id ?? null)) return undefined;
  return current?.id ?? null;
}
