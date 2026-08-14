import { describe, expect, it } from 'vitest';
import type { ChatDmPolicy } from '~/server/schema/chat.schema';
import {
  DEFAULT_CHAT_SETTINGS,
  resolveChatSettings,
  resolveDmPolicy,
} from '~/server/schema/chat.schema';
import { decideDmRouting } from '~/server/utils/chat';

/**
 * Graded DM policy (868kguhpy). The rule that matters is the one this replaces:
 * the old control was binary, so anything short of "everyone" refused outright.
 * Here only `nobody` refuses — every other policy routes to Requests, where the
 * recipient can still find the sender and reply.
 */

const route = (
  policy: ChatDmPolicy,
  overrides: Partial<Parameters<typeof decideDmRouting>[0]> = {}
) =>
  decideDmRouting({
    policy,
    holdNewAccounts: false,
    senderIsNew: false,
    recipientFollowsSender: false,
    senderFollowsRecipient: false,
    ...overrides,
  });

describe('decideDmRouting', () => {
  it('accepts a stranger under the default policy', () => {
    expect(route('everyone')).toBe('accept');
  });

  it('refuses only under "nobody"', () => {
    expect(route('nobody')).toBe('refuse');
    expect(route('nobody', { recipientFollowsSender: true, senderFollowsRecipient: true })).toBe(
      'refuse'
    );

    // The point of the feature: a policy the sender fails is triage, not a wall.
    for (const policy of ['everyone', 'following', 'mutuals'] as const) {
      expect(route(policy)).not.toBe('refuse');
    }
  });

  it('routes by "following" on the recipient\'s follow, not the sender\'s', () => {
    expect(route('following', { recipientFollowsSender: true })).toBe('accept');
    // A sender who follows the recipient has not been vouched for by them.
    expect(route('following', { senderFollowsRecipient: true })).toBe('filter');
  });

  it('requires both directions for "mutuals"', () => {
    expect(route('mutuals', { recipientFollowsSender: true, senderFollowsRecipient: true })).toBe(
      'accept'
    );
    expect(route('mutuals', { recipientFollowsSender: true })).toBe('filter');
    expect(route('mutuals', { senderFollowsRecipient: true })).toBe('filter');
  });

  it('holds new accounts even when they would otherwise qualify', () => {
    expect(route('everyone', { holdNewAccounts: true, senderIsNew: true })).toBe('filter');
    expect(
      route('mutuals', {
        holdNewAccounts: true,
        senderIsNew: true,
        recipientFollowsSender: true,
        senderFollowsRecipient: true,
      })
    ).toBe('filter');
  });

  it('does not let the new-account hold escalate a refusal or apply when off', () => {
    expect(route('nobody', { holdNewAccounts: true, senderIsNew: true })).toBe('refuse');
    expect(route('everyone', { holdNewAccounts: false, senderIsNew: true })).toBe('accept');
    expect(route('everyone', { holdNewAccounts: true, senderIsNew: false })).toBe('accept');
  });
});

describe('resolveDmPolicy', () => {
  it('reads the legacy chat-disabled feature flag as "nobody"', () => {
    expect(resolveDmPolicy({ features: { chat: false } })).toBe('nobody');
    // features.chat wins: it is the switch that predates dmPolicy, and a user who
    // set it has not seen the policy picker.
    expect(resolveDmPolicy({ features: { chat: false }, chat: { dmPolicy: 'everyone' } })).toBe(
      'nobody'
    );
  });

  it('defaults to everyone when nothing is stored', () => {
    expect(resolveDmPolicy({})).toBe('everyone');
    expect(resolveDmPolicy({ features: { chat: true } })).toBe('everyone');
  });

  it('honours a stored policy', () => {
    expect(resolveDmPolicy({ chat: { dmPolicy: 'mutuals' } })).toBe('mutuals');
  });
});

describe('resolveChatSettings', () => {
  it('fills keys absent from a partial stored blob', () => {
    // Users who stored settings before dmPolicy existed must still resolve to a
    // policy — substituting the default wholesale would drop their muteSounds.
    const resolved = resolveChatSettings({ muteSounds: true });
    expect(resolved.muteSounds).toBe(true);
    expect(resolved.dmPolicy).toBe('everyone');
    expect(resolved.holdNewAccounts).toBe(true);
  });

  it('returns the shared default object when nothing is stored', () => {
    // The _app SSR seed and the resolver must agree byte-for-byte (#2471).
    expect(resolveChatSettings(undefined)).toBe(DEFAULT_CHAT_SETTINGS);
  });
});
