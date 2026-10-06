import { buildFliptContext } from '@civitai/flipt/context';

export const TESTER_ID = 42;

type Segment = (context: Record<string, string>) => boolean | null;

const modsAndTesters: Segment = (context) =>
  context.isModerator === 'true' || context.userId === String(TESTER_ID);

/**
 * Stands in for `$lib/server/flipt` (use `vi.mock('$lib/server/flipt', () => fliptModule)`). Like the
 * real client it answers null until `ensureInitialized` has run, matches on the CONTEXT (so a call that
 * drops `fliptContext` reads as off), and answers null for any key but `flag`.
 */
export function createFliptFake(flag: string) {
  const state = { initialized: false, segment: modsAndTesters };
  return {
    state,
    reset() {
      state.initialized = false;
      state.segment = modsAndTesters;
    },
    fliptModule: {
      fliptContext: buildFliptContext,
      getFlipt: () => ({
        ensureInitialized: async () => {
          state.initialized = true;
        },
        isEnabledSync: (key: string, entityId?: string, context: Record<string, string> = {}) => {
          if (!state.initialized || key !== flag) return null;
          if (entityId !== context.userId) throw new Error(`entityId ${entityId} is not the user`);
          return state.segment(context);
        },
      }),
    },
  };
}
