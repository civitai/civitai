import { describe, expect, it } from 'vitest';
import { describeHubSources } from '~/components/Hubs/hub.utils';

const source = (type: string, over: { enabled?: boolean; exclude?: boolean } = {}) => ({
  type,
  enabled: over.enabled ?? true,
  exclude: over.exclude ?? false,
});

describe('describeHubSources', () => {
  it('counts each kind, largest first', () => {
    expect(
      describeHubSources([source('Model'), source('User'), source('User'), source('Tag')])
    ).toBe('2 creators, 1 model, 1 tag');
  });

  it('leaves out the exclusions', () => {
    // The keep-out list is withheld from everyone but the owner, and a card sits on a
    // page a non-owner can open. A count of it publishes by subtraction the one number
    // the service deliberately does not return.
    expect(describeHubSources([source('User'), source('User', { exclude: true })])).toBe(
      '1 creator'
    );
  });

  it('leaves out sources that are switched off, which fill nothing', () => {
    expect(describeHubSources([source('Model'), source('Model', { enabled: false })])).toBe(
      '1 model'
    );
  });

  it('says so when nothing fills the hub', () => {
    expect(describeHubSources([source('User', { exclude: true })])).toBe('Nothing in it yet');
  });
});
