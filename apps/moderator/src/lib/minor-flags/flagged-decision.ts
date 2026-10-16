/** Key order: 1 keeps the flag, 2 lifts it. The main app refuses a keep while the owner has an open
 *  appeal, so that key is off; lifting stays available. */
export const flaggedDecisionEnabled = (row: { hasPendingAppeal: boolean }): readonly boolean[] => [
  !row.hasPendingAppeal,
  true,
];
