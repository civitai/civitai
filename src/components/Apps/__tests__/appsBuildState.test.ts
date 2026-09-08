import { describe, expect, it } from 'vitest';
import {
  APPS_BUILD_STATES,
  resolveAppsBuildState,
  type AppsBuildState,
} from '~/components/Apps/appsBuildState';
import { trackActionSchema } from '~/server/schema/track.schema';

describe('resolveAppsBuildState — the full input table', () => {
  const cases: Array<{
    isAuthor: boolean;
    hasEditableApps: boolean;
    hasSubmissions: boolean;
    expected: AppsBuildState;
  }> = [
    { isAuthor: false, hasEditableApps: false, hasSubmissions: false, expected: 'pitch' },
    // 🔴 A NON-AUTHOR IS `pitch` NO MATTER WHAT THE SUMMARY SAYS. Not hypothetical: an
    // owner who LOSES the author capability keeps their listings, so `hasEditableApps`
    // stays true while `isAuthor` goes false. The workbench reads `appListings.listMine`
    // and its Withdraw carries `enforceAppBlocksFlag`, so rendering it for them would be
    // a table of controls the server refuses.
    { isAuthor: false, hasEditableApps: true, hasSubmissions: false, expected: 'pitch' },
    { isAuthor: false, hasEditableApps: false, hasSubmissions: true, expected: 'pitch' },
    { isAuthor: false, hasEditableApps: true, hasSubmissions: true, expected: 'pitch' },
    { isAuthor: true, hasEditableApps: false, hasSubmissions: false, expected: 'first-app' },
    { isAuthor: true, hasEditableApps: true, hasSubmissions: false, expected: 'workbench' },
    // 🔴 THE ROW THAT MAKES `hasSubmissions` LOAD-BEARING. A submitter whose every
    // listing was deleted has submissions and no editable apps; their orphaned
    // submissions are rendered ONLY by the workbench. Dropping this term from the OR
    // would tell them they have not started yet AND hide the only surface those records
    // have — the same union `/apps/mine`'s sub-nav row carried, for the same reason.
    { isAuthor: true, hasEditableApps: false, hasSubmissions: true, expected: 'workbench' },
    { isAuthor: true, hasEditableApps: true, hasSubmissions: true, expected: 'workbench' },
  ];

  it.each(cases)(
    'author=$isAuthor editable=$hasEditableApps submissions=$hasSubmissions → $expected',
    ({ expected, ...args }) => {
      expect(resolveAppsBuildState(args)).toBe(expected);
    }
  );

  it('🔴 the summary terms are an OR, not an AND', () => {
    // Kills `hasEditableApps && hasSubmissions`, which agrees with the real rule on 6 of
    // the 8 rows above — including every row a hand-written spot check would pick.
    expect(
      resolveAppsBuildState({ isAuthor: true, hasEditableApps: true, hasSubmissions: false })
    ).toBe('workbench');
    expect(
      resolveAppsBuildState({ isAuthor: true, hasEditableApps: false, hasSubmissions: true })
    ).toBe('workbench');
  });

  it('🔴 every state is reachable (guards a constant-returning mutant)', () => {
    // A function that returned one literal would satisfy a table read carelessly; this
    // asserts the image of the function is the whole declared set.
    const produced = new Set(cases.map((c) => resolveAppsBuildState(c)));
    expect([...produced].sort()).toEqual([...APPS_BUILD_STATES].sort());
  });
});

describe('🔴 the SSR / first-paint default', () => {
  /**
   * `blocks.getNavSummary` runs client-only (tRPC is configured `ssr: false`), so on the
   * server render and the first client paint BOTH summary booleans are false. What the
   * function returns for that input is therefore what the server HTML contains — and it
   * has to be a state that is CORRECT for the viewer, not merely a placeholder, because
   * a non-author never gets a second render to correct it.
   */
  it('a non-author renders pitch with no summary — and never moves off it', () => {
    expect(
      resolveAppsBuildState({ isAuthor: false, hasEditableApps: false, hasSubmissions: false })
    ).toBe('pitch');
  });

  it('an author renders first-app with no summary, and may settle FORWARD to workbench', () => {
    const preMount = resolveAppsBuildState({
      isAuthor: true,
      hasEditableApps: false,
      hasSubmissions: false,
    });
    const postMount = resolveAppsBuildState({
      isAuthor: true,
      hasEditableApps: true,
      hasSubmissions: false,
    });
    expect(preMount).toBe('first-app');
    expect(postMount).toBe('workbench');
    // The direction matters: the transition must never be able to run backwards into the
    // pitch, which would flash a recruiting page at someone who already ships apps.
    expect(preMount).not.toBe('pitch');
  });
});

/**
 * 🔴 THE SEAM BETWEEN THE STATE MACHINE AND THE ANALYTICS SCHEMA.
 *
 * `AppsBuildBody` posts the current state as `details.state` on every `AppsBuild_Action`,
 * and `track.schema.ts` validates it against a CLOSED `z.enum`. The two are in different
 * layers with no type relationship, so renaming a state here is a change the compiler
 * cannot see — and the failure is SILENT in the worst way: `/api/track/batch` rejects the
 * malformed event and the browser still gets a 200, so the funnel simply stops receiving
 * that state's rows and reads as "nobody was ever in it".
 *
 * Pins the two sets EQUAL, so it fails whichever side moves.
 */
describe('🔴 APPS_BUILD_STATES matches the values the tracker will accept', () => {
  it('the analytics enum accepts every state, and no others', () => {
    const arm = trackActionSchema.options.find(
      (o) => o.shape.type.value === 'AppsBuild_Action'
    ) as (typeof trackActionSchema.options)[number] & {
      shape: { details: { shape: { state: { options: readonly string[] } } } };
    };
    expect(arm, 'the `AppsBuild_Action` arm is missing from `trackActionSchema`').toBeDefined();
    expect([...arm.shape.details.shape.state.options].sort()).toEqual(
      [...APPS_BUILD_STATES].sort()
    );
  });

  it('positive control: the schema really does reject an unknown state', () => {
    // Without this, the assertion above could pass against a `z.string()` that accepts
    // everything, and the "closed enum" claim would be prose.
    const ok = trackActionSchema.safeParse({
      type: 'AppsBuild_Action',
      details: { action: 'view', state: 'workbench' },
    });
    const bad = trackActionSchema.safeParse({
      type: 'AppsBuild_Action',
      details: { action: 'view', state: 'not-a-state' },
    });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('positive control: the schema rejects an unknown ACTION too', () => {
    const bad = trackActionSchema.safeParse({
      type: 'AppsBuild_Action',
      details: { action: 'not-a-step', state: 'pitch' },
    });
    expect(bad.success).toBe(false);
  });

  it('🔴 the four funnel steps are exactly these', () => {
    // The rollup query names these strings. Pinned as a SET so adding a fifth step is a
    // deliberate edit here (and a reminder that `details` is a String column, so a fifth
    // step needs NO ClickHouse migration — only a new enum VALUE would).
    const arm = trackActionSchema.options.find(
      (o) => o.shape.type.value === 'AppsBuild_Action'
    ) as never as { shape: { details: { shape: { action: { options: readonly string[] } } } } };
    expect([...arm.shape.details.shape.action.options].sort()).toEqual([
      'cli_copy',
      'create_entry',
      'request_access',
      'view',
    ]);
  });
});
