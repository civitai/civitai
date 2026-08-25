import { describe, expect, it } from 'vitest';
import { buildDuplicateHubInput, hubLocksViewerOut, hubUrl } from '~/components/Hubs/hub.utils';
import { getCanonicalSlugDestination } from '~/utils/canonical-slug';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

describe('hubUrl', () => {
  it('keeps the id canonical and adds the slug after it', () => {
    // Articles do it this way, which is what the ticket asked for: the id is what
    // resolves the hub, so a rename cannot break a link anyone already has.
    expect(hubUrl({ id: 12, name: 'Cute Models' })).toBe('/hubs/12/cute-models');
  });

  it('falls back to the bare id when the name slugs to nothing', () => {
    // A hub named entirely in a script `slugit` strips would otherwise produce
    // `/hubs/12/`, which is a different route and 404s.
    expect(hubUrl({ id: 12, name: '???' })).toBe('/hubs/12');
  });
});

describe('hubUrl agrees with the canonical redirect', () => {
  // Two independent spellings of the same URL: `hubUrl` builds every internal link,
  // and the route redirects to `getCanonicalSlugDestination`. Give either one a
  // normalisation of its own and every hub link 307s on arrival, forever, with both
  // suites green.
  for (const name of ['Cute Models', 'Ellie & Co.', '???']) {
    it(`does not redirect a link it built itself: ${name}`, () => {
      const hub = { id: 12, name };

      expect(
        getCanonicalSlugDestination({
          basePath: '/hubs',
          id: hub.id,
          title: hub.name,
          currentSlug: hubUrl(hub).split('/')[3],
        })
      ).toBeNull();
    });
  }
});

describe('hubLocksViewerOut', () => {
  it('is false when the hub sets no cap', () => {
    expect(hubLocksViewerOut(0, 1)).toBe(false);
  });

  it('is false while anything the hub allows is something the viewer can see', () => {
    expect(hubLocksViewerOut(1 | 2, 1)).toBe(false);
  });

  it('is true when the two do not overlap at all', () => {
    // The state Justin reviewed: a hub capped to X, a PG viewer. The banner and the
    // feed must be computed from this one function, or the banner can claim a lockout
    // over a feed with results.
    expect(hubLocksViewerOut(8, 1)).toBe(true);
  });
});

describe('buildDuplicateHubInput', () => {
  // Every fixture carries a row `id`, because that is what `getById` returns and it
  // is the only thing an id assertion below can catch. With id-less fixtures,
  // spreading the whole source instead of picking fields stays green — and in
  // production that spreads the ORIGINAL hub's source-row ids into the copy.
  let nextId = 100;
  const source = (targetId: number, enabled = true) => ({
    id: nextId++,
    type: UserHubSourceType.User,
    targetId,
    alias: `creator-${targetId}`,
    enabled,
    index: 0,
  });

  const hub = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'Cute Models',
    forcedBrowsingLevel: 0,
    sources: [source(1)],
    ...over,
  });

  it('copies only the sources the original has switched on', () => {
    const result = buildDuplicateHubInput(hub({ sources: [source(1), source(2, false)] }));

    // The ids, not the count: dropping the wrong one gives a copy that does not
    // match what the copier was looking at, and the length is the same either way.
    expect(result.sources.map((s) => s.targetId)).toEqual([1]);
  });

  it('reindexes from zero rather than carrying the original positions', () => {
    const result = buildDuplicateHubInput(
      hub({ sources: [source(1, false), source(2), source(3)] })
    );

    expect(result.sources.map((s) => s.index)).toEqual([0, 1]);
  });

  it('marks the copy as a copy, within the name limit the server enforces', () => {
    const long = 'x'.repeat(hubLimits.nameLength);

    const result = buildDuplicateHubInput(hub({ name: long, sources: [] }));

    // Truncated rather than rejected: the server caps `name` at this length, so an
    // untrimmed suffix turns Duplicate into a mutation that always fails.
    expect(result.name.length).toBe(hubLimits.nameLength);
    expect(buildDuplicateHubInput(hub({ sources: [] })).name).toBe('Cute Models (copy)');
  });

  it('carries no id, so saving creates a hub instead of overwriting the original', () => {
    const result = buildDuplicateHubInput(hub()) as Record<string, unknown>;

    expect(result.id).toBeUndefined();
    expect(result.sources).not.toContainEqual(expect.objectContaining({ id: expect.anything() }));
  });

  it('carries the original content level', () => {
    // The level is the reason the level exists — Ellie's hub gathers creators whose
    // other work is porn. A copy without it hands that list over uncapped.
    expect(buildDuplicateHubInput(hub({ forcedBrowsingLevel: 1 | 2 })).forcedBrowsingLevel).toBe(
      1 | 2
    );
  });

  it('defaults the level to uncapped when the original had none', () => {
    expect(buildDuplicateHubInput(hub()).forcedBrowsingLevel).toBe(0);
  });
});
