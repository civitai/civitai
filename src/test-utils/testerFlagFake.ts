/**
 * Stands in for `~/server/flipt/tester-segment`, the only door event access uses to Flipt. One
 * flag state per test file, shared by every flag key (the keys asked are recorded in `asked`):
 *
 * - `public`: the base is on, so everyone is on.
 * - `testers`: user ids the testers rollout matches while the base is off.
 * - `readable`: false is Flipt not initialised (or the flag missing): like the real client, every
 *   evaluation then answers false, and only moderators stay on (they never ask Flipt).
 *
 * Wire it with
 * `vi.mock('~/server/flipt/tester-segment', async () => (await import('~/test-utils/testerFlagFake')).testerFlagModule)`
 * and call `testerFlag.reset()` in `beforeEach`.
 */
export const testerFlag = {
  public: false,
  readable: true,
  testers: new Set<number>(),
  asked: [] as string[],
  reset({ public: isPublic = false, readable = true, testers = [] as number[] } = {}) {
    this.public = isPublic;
    this.readable = readable;
    this.testers = new Set(testers);
    this.asked = [];
  },
};

const evaluate = (flag: string, on: boolean) => {
  testerFlag.asked.push(flag);
  return testerFlag.readable && on;
};

export const testerFlagModule = {
  isFliptOnForTesters: async (flag: string, user: { id?: number; isModerator?: boolean }) => {
    if (user.isModerator) return true;
    if (!user.id) return false;
    return evaluate(flag, testerFlag.public || testerFlag.testers.has(user.id));
  },
  isFliptPublic: async (flag: string) => evaluate(flag, testerFlag.public),
  isFliptFlagReadable: async (flag: string) => {
    testerFlag.asked.push(flag);
    return testerFlag.readable;
  },
};
