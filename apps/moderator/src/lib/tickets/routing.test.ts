import { describe, expect, it } from 'vitest';
import { TICKET_ROUTING, routeTicket } from './routing';

const OPEN = 2;
const WAITING_ON_MOD_LEAD = 8;

describe('routeTicket', () => {
  it.each(TICKET_ROUTING.moderationFeatures)(
    'cf_feature "%s" routes to moderation',
    (cfFeature) => {
      expect(routeTicket({ cfFeature, status: OPEN, routerTopic: null })).toBe('moderation');
    }
  );

  it('status "Waiting on Mod Lead" routes to moderation whatever the feature', () => {
    expect(
      routeTicket({ cfFeature: 'Billing', status: WAITING_ON_MOD_LEAD, routerTopic: null })
    ).toBe('moderation');
  });

  it.each(TICKET_ROUTING.fallbackTopics)(
    'no cf_feature and router topic "%s" routes to moderation',
    (routerTopic) => {
      expect(routeTicket({ cfFeature: null, status: OPEN, routerTopic })).toBe('moderation');
      expect(routeTicket({ cfFeature: '  ', status: OPEN, routerTopic })).toBe('moderation');
    }
  );

  it('a cf_feature set to a support value beats a moderation router topic', () => {
    expect(
      routeTicket({ cfFeature: 'Billing', status: OPEN, routerTopic: 'nsfw-moderation' })
    ).toBe('support');
  });

  it('no cf_feature and an unrelated or missing router topic routes to support', () => {
    expect(routeTicket({ cfFeature: null, status: OPEN, routerTopic: 'account-issue' })).toBe(
      'support'
    );
    expect(routeTicket({ cfFeature: null, status: OPEN, routerTopic: null })).toBe('support');
  });

  it('an unknown cf_feature routes to support', () => {
    expect(
      routeTicket({ cfFeature: 'Content Related Issue', status: OPEN, routerTopic: null })
    ).toBe('support');
  });
});
