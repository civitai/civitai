import { describe, expect, it } from 'vitest';
import { PANELS, type PanelKey } from '../panels';
import {
  ACCOUNT_RESTRICTION_FEATURE,
  CONTENT_RELATED_FEATURE,
  IMAGE_GENERATOR_FEATURE,
  LORA_TRAINER_FEATURE,
  type TicketView,
} from '../routing';

const SHOWN_IN: Record<PanelKey, TicketView> = {
  account: 'moderation',
  appeals: 'moderation',
  history: 'moderation',
  ratingDisputes: 'moderation',
  contentIssue: 'support',
  generator: 'support',
  lora: 'support',
};

// A ticket every panel would show on, in the view it belongs to: features and topics of both views.
const triggers = [
  { cfFeature: ACCOUNT_RESTRICTION_FEATURE, routerTopic: 'account-issue' },
  { cfFeature: IMAGE_GENERATOR_FEATURE, routerTopic: null },
  { cfFeature: CONTENT_RELATED_FEATURE, routerTopic: null },
  { cfFeature: LORA_TRAINER_FEATURE, routerTopic: null },
];

describe('PANELS', () => {
  it('declares the view of every registered panel', () => {
    expect(Object.keys(SHOWN_IN).sort()).toEqual(Object.keys(PANELS).sort());
  });

  it.each(Object.keys(PANELS) as PanelKey[])('%s is hidden in the other view', (key) => {
    const other: TicketView = SHOWN_IN[key] === 'moderation' ? 'support' : 'moderation';
    const shownSomewhere = triggers.some(
      (t) => PANELS[key].visibility({ view: SHOWN_IN[key], civitaiUserId: 7, ...t }) !== 'hidden'
    );
    expect(shownSomewhere).toBe(true);
    for (const t of triggers) {
      expect(PANELS[key].visibility({ view: other, civitaiUserId: 7, ...t })).toBe('hidden');
    }
  });
});
