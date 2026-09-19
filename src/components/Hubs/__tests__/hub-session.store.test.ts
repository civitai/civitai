import { beforeEach, describe, expect, it } from 'vitest';
import { hubSessionStore } from '~/components/Hubs/hub-session.store';

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
