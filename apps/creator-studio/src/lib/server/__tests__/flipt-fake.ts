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
    // Un-initializes, which the real client never does, so every test starts cold and an unawaited
    // or reordered warm-up fails in each test rather than only the first.
    reset() {
      state.initialized = false;
      state.segment = modsAndTesters;
    },
    fliptModule: {
      fliptContext: buildFliptContext,
      getFlipt: () => ({
        // A real hop, so a caller that forgets to await the warm-up evaluates before it lands.
        ensureInitialized: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
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
