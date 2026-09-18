import { describe, expect, it } from 'vitest';
import { describeHubSources } from '~/components/Hubs/hub.utils';

// The counts arrive already narrowed by the server — `toHubSummary` is what drops the
// switched-off sources and the keep-out list, and `user-hub.service.test.ts` pins that.
// What is left here is the sentence built from them.

describe('describeHubSources', () => {
  it('names each kind, largest first', () => {
    expect(describeHubSources({ Model: 1, User: 2, Tag: 1 })).toBe('2 creators, 1 model, 1 tag');
  });

  it('says creator rather than user — the noun the site uses', () => {
    expect(describeHubSources({ User: 1 })).toBe('1 creator');
  });

  it('skips a kind the hub holds none of', () => {
    // A zero from the server means "no sources of this kind", not "a kind worth
    // mentioning" — "0 tags" in a nav row reads as a broken count.
    expect(describeHubSources({ Model: 3, Tag: 0 })).toBe('3 models');
  });

  it('says so when nothing fills the hub', () => {
    expect(describeHubSources({})).toBe('Nothing in it yet');
  });
});
