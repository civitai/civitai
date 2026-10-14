export const pastAppealsText = (past: {
  approved: number;
  rejected: number;
  void: number;
  pending: number;
}): string => {
  const parts = [
    past.approved && `${past.approved} approved`,
    past.rejected && `${past.rejected} rejected`,
    past.void && `${past.void} void`,
    past.pending && `${past.pending} other open`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'none';
};

export const clipList = <T>(
  items: T[],
  max: number,
  total = items.length
): { shown: T[]; more: number } => {
  const shown = items.slice(0, max);
  return { shown, more: Math.max(0, total - shown.length) };
};
