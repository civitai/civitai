import { describe, expect, it } from 'vitest';
import { buildDuplicateHubInput, hubUrl } from '~/components/Hubs/hub.utils';
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
