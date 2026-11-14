/** The monthly `KnightsVote` partition's table name; `month` is 1-12. */
export const votePartitionName = ({ year, month }: { year: number; month: number }) =>
  `KnightsVote_${year}_${String(month).padStart(2, '0')}`;
