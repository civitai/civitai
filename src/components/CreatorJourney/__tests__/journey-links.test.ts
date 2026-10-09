import { describe, expect, it } from 'vitest';
import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '~/__tests__/mocks/db.mock';
import {
  LinkedText,
  rewardLinks,
  unlockLinks,
  unlockLinksFor,
} from '~/components/CreatorJourney/journey-links';
import { tierRewards } from '~/components/CreatorJourney/tier-rewards';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import { groupCreatorScoreUnlocks } from '~/shared/utils/creator-score-unlocks';

const registry = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs);
const family = (key: string) => key.split(':')[0];

// Unlocks with no page to send a creator to. Adding an unlock to the registry fails the test below
// until it is either linked in `unlockLinks` or listed here on purpose.
const UNLINKED = ['comment-rate-limit', 'reaction-rate-limit'];

// MantineProvider prepends a <style> block; drop it, then the tags, to read what a person sees.
const visibleText = (html: string) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
const render = (text: string, links: Parameters<typeof LinkedText>[0]['links']) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(LinkedText, { text, links }))
  );

describe('journey ladder links', () => {
  it('decides a link for every unlock family in the registry', () => {
    const families = [...new Set(registry.map((unlock) => family(unlock.key)))];
    expect(families.filter((key) => !unlockLinks[key] && !UNLINKED.includes(key))).toEqual([]);
    expect(Object.keys(unlockLinks).filter((key) => !families.includes(key))).toEqual([]);
  });

  // A phrase that drifts out of its label renders as plain text without complaint, so pin it here.
  it('finds every linked phrase in the label it links, as the ladder groups them', () => {
    const missing = groupCreatorScoreUnlocks(registry).flatMap((group) =>
      unlockLinksFor(group.key)
        .filter((link) => link.phrase && !group.label.includes(link.phrase))
        .map((link) => `${group.label} -> ${link.phrase}`)
    );
    expect(missing).toEqual([]);
  });

  it('links each phrase of "Create challenges and crucibles" to its own create page', () => {
    const label = registry.find((unlock) => unlock.key === 'challenge-create')?.label ?? '';
    const html = render(label, unlockLinksFor('challenge-create'));
    expect(hrefs(html)).toEqual(['/challenges/create', '/crucibles/create']);
    expect(visibleText(html)).toBe(label);
  });

  it('links the Creator Showcase and the profile from the tier rewards', () => {
    const rewards = Object.values(tierRewards).flat() as string[];
    const linked = rewards.flatMap((reward) => hrefs(render(reward, rewardLinks('alice'))));
    expect(linked.filter((href) => href === '/creators/showcase')).toHaveLength(2);
    expect(linked).toContain('/user/alice');
  });

  it('leaves the line whole and unlinked when a phrase is absent', () => {
    const html = render('Higher comment limits', [{ phrase: 'crucibles', href: '/crucibles' }]);
    expect(hrefs(html)).toEqual([]);
    expect(visibleText(html)).toBe('Higher comment limits');
  });
});
