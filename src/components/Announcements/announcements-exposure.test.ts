import { describe, expect, test } from 'vitest';
import { resolveAnnouncementExposure } from '~/components/Announcements/announcements-exposure';

/**
 * Deterministic regression tests for the durable feed-CLS fix. These exercise the
 * exact SSR→hydration transitions that the net-negative min-height reserve was
 * papering over:
 *   - the SERVER render is `isClient=false`,
 *   - the FIRST client paint is ALSO `isClient=false` (the useIsClient boundary),
 *   - every render afterwards is `isClient=true`.
 * Hydration safety = the output at the last `isClient=false` render must equal the
 * first `isClient=true` render (given the store initialised from the same cookie).
 */

const A = { id: 1, title: 'a' };
const B = { id: 2, title: 'b' };
const typed = [A, B];
const visible = (out: Array<{ id: number; dismissed: boolean }>) =>
  out.filter((x) => !x.dismissed).map((x) => x.id);

describe('resolveAnnouncementExposure — flag ON (SSR-exact, site placement)', () => {
  // Dismisser: the active announcement #1 is in the cookie (seed AND store).
  const dismissedStore = [1];
  const dismissedSeed = [1];

  test('DISMISSER: server + first client paint render the SAME non-empty set with #1 marked dismissed (no empty→reserve flash)', () => {
    // Server render.
    const server = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: false,
      dismissedStore,
      dismissedSeed,
    });
    // First client paint (still isClient=false).
    const firstPaint = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: false,
      dismissedStore,
      dismissedSeed,
    });
    // Both expose the real data (NOT []), with #1 dismissed and #2 visible.
    expect(server).toEqual(firstPaint);
    expect(visible(server)).toEqual([2]);
  });

  test('DISMISSER: output is STABLE across the hydration boundary (isClient false → true) — no post-hydration collapse', () => {
    const preHydration = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: false,
      dismissedStore,
      dismissedSeed,
    });
    const postHydration = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: true,
      dismissedStore, // store initialised from the same cookie as the seed
      dismissedSeed,
    });
    // Identical → the banner does not appear-then-collapse (the regression).
    expect(postHydration).toEqual(preHydration);
    expect(visible(postHydration)).toEqual([2]);
  });

  test('DISMISSER of the ONLY active announcement → empty from frame 0 and stable (SSR renders nothing, no reserve)', () => {
    const onlyOne = [A];
    const server = resolveAnnouncementExposure({
      typed: onlyOne,
      exposeSSR: true,
      isClient: false,
      dismissedStore: [1],
      dismissedSeed: [1],
    });
    const postHydration = resolveAnnouncementExposure({
      typed: onlyOne,
      exposeSSR: true,
      isClient: true,
      dismissedStore: [1],
      dismissedSeed: [1],
    });
    expect(visible(server)).toEqual([]); // nothing to render on the server
    expect(server).toEqual(postHydration); // and it never inserts-then-collapses
  });

  test('MIGRATION FIRST LOAD: seed empty (no cookie server-side yet) but store dismissed (client migration) → SSR/first-paint EXPOSE, post-hydration FILTERS (the one-time, self-healing divergence)', () => {
    // A legacy localStorage dismisser's FIRST load of the new bundle: the
    // localStorage→cookie migration runs client-only, so the server has no cookie
    // (`dismissedSeed=[]`) while the just-migrated client store holds the dismissal
    // (`dismissedStore=[1]`). This is the ONLY intentional SSR-vs-post-hydration
    // divergence — a one-time upward shift that self-heals on the 2nd load (the
    // cookie then exists → seed matches store). Pinned here as intentional.
    const dismissedSeedMig = [] as number[]; // no cookie server-side
    const dismissedStoreMig = [1]; // migrated from localStorage on the client

    // Server render AND first client paint (both isClient=false) use the seed →
    // #1 is NOT dismissed → the carousel is exposed. First paint == SSR (no
    // hydration error).
    const server = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: false,
      dismissedStore: dismissedStoreMig,
      dismissedSeed: dismissedSeedMig,
    });
    expect(visible(server)).toEqual([1, 2]);

    // Post-hydration (isClient=true) switches to the migrated store → #1 filtered
    // out. This is the single expected divergence from the pre-hydration render.
    const postHydration = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: true,
      dismissedStore: dismissedStoreMig,
      dismissedSeed: dismissedSeedMig,
    });
    expect(visible(postHydration)).toEqual([2]);
    expect(postHydration).not.toEqual(server); // the known one-time collapse
  });

  test('NON-DISMISSER: the real carousel data is present on the server render (renders from server HTML), no post-hydration insert', () => {
    const server = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: false,
      dismissedStore: [],
      dismissedSeed: [],
    });
    const postHydration = resolveAnnouncementExposure({
      typed,
      exposeSSR: true,
      isClient: true,
      dismissedStore: [],
      dismissedSeed: [],
    });
    expect(visible(server)).toEqual([1, 2]); // both visible in SSR HTML
    expect(server).toEqual(postHydration); // no shift on hydration
  });
});

describe('resolveAnnouncementExposure — flag OFF / non-site (byte-identical to pre-fix)', () => {
  test('FLAG OFF: server + first client paint are EMPTY regardless of cookie (isClient gate preserved)', () => {
    const server = resolveAnnouncementExposure({
      typed,
      exposeSSR: false,
      isClient: false,
      dismissedStore: [1],
      dismissedSeed: [1],
    });
    expect(server).toEqual([]); // exactly the old behaviour: nothing on the server
  });

  test('FLAG OFF: post-hydration is store-driven (the old dismissed source)', () => {
    const postHydration = resolveAnnouncementExposure({
      typed,
      exposeSSR: false,
      isClient: true,
      dismissedStore: [1],
      dismissedSeed: [999], // seed must be IGNORED when flag off
    });
    expect(visible(postHydration)).toEqual([2]); // #1 dismissed via STORE, not seed
  });

  test('FLAG OFF ignores the seed entirely (proves no accidental SSR exposure)', () => {
    const server = resolveAnnouncementExposure({
      typed,
      exposeSSR: false,
      isClient: false,
      dismissedStore: [],
      dismissedSeed: [], // even an empty seed must not expose on the server
    });
    expect(server).toEqual([]);
  });
});
