/** One key per standing shown, so closing one card never hides a later one. */
export const noticeKey = (notice: { rank: string; level: number }) =>
  `${notice.rank}:${notice.level}`;
