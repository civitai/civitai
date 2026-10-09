/**
 * Stands in for `~/server/flipt/tester-segment`, the only door event access uses to Flipt. One
 * flag state per test file, shared by every flag key:
 *
 * - `public`: the base is on, so everyone is on.
 * - `testers`: user ids the testers rollout matches while the base is off.
 * - `readable`: whether a "no" is a real answer (false = Flipt not initialised / flag missing).
 *
 * Moderators are always on, as in the real helper. Wire it with
 * `vi.mock('~/server/flipt/tester-segment', async () => (await import('~/test-utils/testerFlagFake')).testerFlagModule)`
 * and call `testerFlag.reset()` in `beforeEach`.
 */
export const testerFlag = {
  public: false,
  readable: true,
  testers: new Set<number>(),
  reset({ public: isPublic = false, readable = true, testers = [] as number[] } = {}) {
    this.public = isPublic;
    this.readable = readable;
    this.testers = new Set(testers);
  },
};

export const testerFlagModule = {
  isFliptOnForTesters: async (_flag: string, user: { id?: number; isModerator?: boolean }) =>
    !!user.isModerator || (!!user.id && (testerFlag.public || testerFlag.testers.has(user.id))),
  isFliptPublic: async () => testerFlag.public,
  isFliptFlagReadable: async () => testerFlag.readable,
};
