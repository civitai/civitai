import { describe, expect, it } from 'vitest';
import { dealAcceptedChatLine } from '~/shared/utils/creator-service-deal-chat-line';

describe('deal accepted chat line', () => {
  it('names the seller, so both parties read whose service it is', () => {
    expect(dealAcceptedChatLine({ dealId: 7, sellerName: 'Penny', title: 'Photo set' })).toBe(
      "Deal accepted: Penny's service **Photo set**. [Open the deal](/services/deals/7)"
    );
  });

  it('adds no full stop after a title that already ends its sentence', () => {
    for (const title of ['Make you a photo!', 'Why not?', 'Done.']) {
      const line = dealAcceptedChatLine({ dealId: 1, sellerName: 'Penny', title });
      expect(line).toContain(`**${title}** [Open`);
    }
  });

  it('strips markdown from names and falls back when the seller has no username', () => {
    expect(dealAcceptedChatLine({ dealId: 1, sellerName: 'a_b*c', title: 'x[y]' })).toContain(
      "abc's service **xy**."
    );
    expect(dealAcceptedChatLine({ dealId: 1, sellerName: null, title: 'T' })).toContain(
      'Deal accepted: the service **T**.'
    );
  });
});
