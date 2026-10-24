import { beforeEach, describe, expect, it } from 'vitest';
import { hubSessionStore, selectHubExcludedSources } from '~/components/Hubs/hub-session.store';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

/**
 * What a viewer changes on a hub they do not own: a content level, a sort, a filter.
 * The property no component can show is that an untouched hub yields the SAME object
 * every read — these feed react-query keys, and a fresh one per render refetches the
 * feed forever.
 */

const state = () => hubSessionStore.getState();

// The store is a module singleton, so a shared hub id would let one test decide
// another's result.
let hubId = 0;
beforeEach(() => {
  hubId += 1;
});

describe('hub session content settings', () => {
  it('remembers a level per hub and reports nothing for an untouched one', () => {
    expect(state().browsingLevel[hubId]).toBeUndefined();

    state().setBrowsingLevel(hubId, 1 | 2);
    expect(state().browsingLevel[hubId]).toBe(1 | 2);
    expect(state().browsingLevel[hubId + 5000]).toBeUndefined();
  });

  it('defaults the PG-13 opt-in to off rather than inheriting anything', () => {
    // The owner's stored `includePG13` must not reach a viewer: on green it decides
    // whether that viewer's own cap is narrowed to PG.
    expect(state().includePG13[hubId] ?? false).toBe(false);

    state().setIncludePG13(hubId, true);
    expect(state().includePG13[hubId]).toBe(true);
  });
});

// Restored 2026-09-21 after Justin reversed the 2026-09-17 call. The rows go straight
// to the feed query, so both the shape and the stability of the empty case matter.
describe('per-session source mutes', () => {
  const source = { type: UserHubSourceType.User, targetId: 11 };

  it('toggles a source off and back on again', () => {
    state().toggleSource(hubId, source);
    expect(state().excludedSources[hubId]).toEqual([source]);

    state().toggleSource(hubId, source);
    expect(state().excludedSources[hubId]).toEqual([]);
  });

  it('tells a tag from a creator that shares its id', () => {
    // 🔴 The rows are keyed on type AND id. Matching on the id alone would have
    // toggling a creator silently un-mute a tag, and the feed would quietly widen.
    state().toggleSource(hubId, source);
    state().toggleSource(hubId, { type: UserHubSourceType.Tag, targetId: 11 });

    expect(state().excludedSources[hubId]).toHaveLength(2);
  });

  it('hands back the SAME empty array for an untouched hub', () => {
    // It feeds a react-query key, so a fresh [] per render is a new key per render and
    // the feed refetches forever. `toEqual([])` would pass against exactly that bug.
    expect(state().excludedSources[hubId]).toBeUndefined();
    expect(selectHubExcludedSources(hubId)(state())).toBe(
      selectHubExcludedSources(hubId + 500)(state())
    );
  });

  it('clears every mute on a hub without touching another hub', () => {
    state().toggleSource(hubId, source);
    state().toggleSource(hubId + 1000, source);

    state().clearExcludedSources(hubId);

    expect(state().excludedSources[hubId]).toEqual([]);
    expect(state().excludedSources[hubId + 1000]).toEqual([source]);
  });
});
