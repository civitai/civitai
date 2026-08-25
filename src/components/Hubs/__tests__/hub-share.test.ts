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
  const source = (targetId: number, enabled = true) => ({
    type: UserHubSourceType.User,
    targetId,
    alias: `creator-${targetId}`,
    enabled,
  });

  it('copies only the sources the original has switched on', () => {
    const result = buildDuplicateHubInput({
      name: 'Cute Models',
      sources: [source(1), source(2, false)],
    });

    // The ids, not the count: dropping the wrong one gives a copy that does not
    // match what the copier was looking at, and the length is the same either way.
    expect(result.sources.map((s) => s.targetId)).toEqual([1]);
  });

  it('reindexes from zero rather than carrying the original positions', () => {
    const result = buildDuplicateHubInput({
      name: 'Cute Models',
      sources: [source(1, false), source(2), source(3)],
    });

    expect(result.sources.map((s) => s.index)).toEqual([0, 1]);
  });

  it('marks the copy as a copy, within the name limit the server enforces', () => {
    const long = 'x'.repeat(hubLimits.nameLength);

    const result = buildDuplicateHubInput({ name: long, sources: [] });

    // Truncated rather than rejected: the server caps `name` at this length, so an
    // untrimmed suffix turns Duplicate into a mutation that always fails.
    expect(result.name.length).toBe(hubLimits.nameLength);
    expect(buildDuplicateHubInput({ name: 'Cute Models', sources: [] }).name).toBe(
      'Cute Models (copy)'
    );
  });

  it('carries no id, so saving creates a hub instead of overwriting the original', () => {
    const result = buildDuplicateHubInput({ name: 'Cute Models', sources: [source(1)] }) as Record<
      string,
      unknown
    >;

    expect(result.id).toBeUndefined();
    expect(result.sources).not.toContainEqual(expect.objectContaining({ id: expect.anything() }));
  });
});
