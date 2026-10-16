/** Key order: 1 keeps the flag, 2 lifts it. The main app refuses to keep a flag while the owner has an
 *  open appeal. A hash or text-scan row can still be lifted (the ruling settles the appeal); a
 *  re-detection is refused either way, so both keys go off. */
export const flaggedDecisionEnabled = (row: {
  source: 'hash' | 'redetected' | 'text-scan';
  hasPendingAppeal: boolean;
}): readonly boolean[] => [
  !row.hasPendingAppeal,
  !(row.hasPendingAppeal && row.source === 'redetected'),
];
