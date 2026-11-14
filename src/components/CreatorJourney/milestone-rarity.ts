/** The tile's share-of-creators line; null when there is no count to show. */
export function rarityLabel(percent: number | null | undefined) {
  if (percent == null) return null;
  if (percent > 0 && percent < 0.1) return '<0.1% of creators';
  const rounded = percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent);
  return `${rounded}% of creators`;
}
