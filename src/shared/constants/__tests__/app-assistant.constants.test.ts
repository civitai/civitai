import { describe, expect, it } from 'vitest';
import { appAssistantHoldsScopes } from '~/shared/constants/app-assistant.constants';

describe('appAssistantHoldsScopes (the chat grant check)', () => {
  it.each([
    [['ai:write:budgeted']],
    [['user:read:self']],
    [['ai:write:budgeted', 'user:read:self']],
    [[]],
  ])('grants %j, which the chat token already holds', (scopes) => {
    expect(appAssistantHoldsScopes(scopes)).toBe(true);
  });

  it.each([
    [['posts:write:self']],
    [['ai:write:budgeted', 'posts:write:self']],
    [['collections:write:self']],
  ])('refuses %j, which this page cannot grant', (scopes) => {
    expect(appAssistantHoldsScopes(scopes)).toBe(false);
  });
});
