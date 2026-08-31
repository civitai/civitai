import { beforeEach, describe, expect, it } from 'vitest';
import { hubSessionStore, selectHubExcludedSources } from '~/components/Hubs/hub-session.store';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

/**
 * What a viewer changes on a hub they do not own. Two properties here cannot be seen
 * from the components that use them: that a source is keyed on the (type, targetId)
 * PAIR, and that an untouched hub yields the same array object every read.
 */

const creator = { type: UserHubSourceType.User, targetId: 42 };
const state = () => hubSessionStore.getState();
const excludedOf = (hubId: number) => selectHubExcludedSources(hubId)(state());

// The store is a module singleton, so a shared hub id would let one test decide
// another's result.
let hubId = 0;
beforeEach(() => {
  hubId += 1;
});

describe('hub session source toggles', () => {
  it('records a source switched off, and forgets it when switched back on', () => {
    state().toggleSource(hubId, creator, false);
    expect(excludedOf(hubId)).toEqual([creator]);

    state().toggleSource(hubId, creator, true);
    expect(excludedOf(hubId)).toEqual([]);
  });

  it('keys on the type and the id together, not on the id alone', () => {
    // A model and a creator can share an id. Keying on `targetId` alone would drop
    // the wrong source from the feed and look exactly like dropping the right one.
    const model = { type: UserHubSourceType.Model, targetId: creator.targetId };

    state().toggleSource(hubId, creator, false);
    state().toggleSource(hubId, model, false);
    expect(excludedOf(hubId)).toHaveLength(2);

    state().toggleSource(hubId, creator, true);
    expect(excludedOf(hubId)).toEqual([model]);
  });

  it('does not record the same source twice', () => {
    state().toggleSource(hubId, creator, false);
    state().toggleSource(hubId, creator, false);

    expect(excludedOf(hubId)).toEqual([creator]);
  });

  it('keeps one hub out of another', () => {
    const other = hubId + 5000;
    state().toggleSource(hubId, creator, false);

    expect(excludedOf(other)).toEqual([]);
  });

  it('yields the SAME empty array for an untouched hub', () => {
    // This feeds a react-query key. A fresh `[]` per read is a new key per render,
    // which refetches the feed forever — a hang rather than a failed assertion, so
    // nothing else in the suite would report it.
    expect(excludedOf(hubId)).toBe(excludedOf(hubId));
  });

  it('yields a DIFFERENT array once the hub has an exclusion', () => {
    // The control: without it the assertion above passes for a selector that returns
    // one shared constant no matter what, which would drop every exclusion.
    state().toggleSource(hubId, creator, false);

    expect(excludedOf(hubId)).not.toBe(excludedOf(hubId + 5000));
  });
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
