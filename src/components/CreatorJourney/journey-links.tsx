import { Anchor } from '@mantine/core';
import type { ReactNode } from 'react';
import { CREATOR_ANNOUNCEMENTS_URL } from '~/components/Announcements/creator-announcements-entry';
import { NextLink } from '~/components/NextLink/NextLink';
import { CREATOR_SHOWCASE_HREF } from '~/shared/constants/creator-journey.constants';
import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';

/** A link on part of a line of copy. Without `phrase` the whole line links. */
export type PhraseLink = { phrase?: string; href: string };

const studioModels = { href: `${CREATOR_STUDIO_URL}/models` };
// Where the price and free-slot sliders live, per surface; `/user/placements` is only the queue.
// The bare account path, not `/creator`: the legacy page has no sub-paths and drops the fragment.
const creatorControls = { href: '/user/account#creator-controls' };

/**
 * Where each ladder unlock leads, keyed by the unlock key's family (the part before the first `:`),
 * which is also how `groupCreatorScoreUnlocks` groups them. Comment and reaction limits have no page.
 */
export const unlockLinks: Record<string, PhraseLink[]> = {
  'crucible-judge': [{ href: '/crucibles' }],
  'daily-posts': [{ href: '/posts/create' }],
  'daily-articles': [{ href: '/articles/create' }],
  'challenge-create': [
    { phrase: 'challenges', href: '/challenges/create' },
    { phrase: 'crucibles', href: '/crucibles/create' },
  ],
  'monetize-pricing': [studioModels],
  'monetize-sales': [{ href: `${CREATOR_STUDIO_URL}/sales` }],
  'early-access-days': [studioModels],
  'early-access-quantity': [studioModels],
  announcements: [{ href: CREATOR_ANNOUNCEMENTS_URL }],
  'placement-price-cap': [creatorControls],
  'placement-free-slots': [creatorControls],
  'creator-program': [{ phrase: 'Creator Program', href: '/creator-program' }],
};

export const unlockLinksFor = (key: string) => unlockLinks[key.split(':')[0]] ?? [];

/**
 * Each unlock row's links down the whole ladder, rung boundaries included. A row that would link
 * the same place as the unlock row directly above is left plain: testers saw one Creator Studio
 * link six rows running. `null` is a row that is not an unlock (a tier reward); it gets no links
 * here and ends a run.
 */
export function unlockLinksDownLadder(rows: (string | null)[]): PhraseLink[][] {
  let previous = '';
  return rows.map((key) => {
    if (key === null) {
      previous = '';
      return [];
    }
    const links = unlockLinksFor(key);
    const signature = links.map((link) => `${link.phrase ?? ''}>${link.href}`).join('|');
    const repeat = signature !== '' && signature === previous;
    previous = signature;
    return repeat ? [] : links;
  });
}

export function rewardLinks(username?: string): PhraseLink[] {
  return [
    { phrase: 'Creator Showcase', href: CREATOR_SHOWCASE_HREF },
    ...(username ? [{ phrase: 'on your profile', href: `/user/${username}` }] : []),
  ];
}

/**
 * `text` with each link's phrase (its first occurrence) linked. A phrase missing from the text is
 * skipped, so the line still reads; `journey-links.test.ts` keeps the registry labels in step.
 */
export function LinkedText({ text, links }: { text: string; links: PhraseLink[] }) {
  const whole = links.find((link) => !link.phrase);
  if (whole) return <PhraseAnchor href={whole.href}>{text}</PhraseAnchor>;

  const found = links
    .map((link) => ({ ...link, at: text.indexOf(link.phrase as string) }))
    .filter((link) => link.at >= 0)
    .sort((a, b) => a.at - b.at);

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const link of found) {
    if (link.at < cursor) continue;
    const end = link.at + (link.phrase as string).length;
    parts.push(text.slice(cursor, link.at));
    parts.push(
      <PhraseAnchor key={link.href} href={link.href}>
        {text.slice(link.at, end)}
      </PhraseAnchor>
    );
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// `//host` is protocol-relative, so it leaves the site and must not go through NextLink.
export const isAppPath = (href: string) => href.startsWith('/') && !href.startsWith('//');

function PhraseAnchor({ href, children }: { href: string; children: ReactNode }) {
  return isAppPath(href) ? (
    <Anchor component={NextLink} href={href} inherit>
      {children}
    </Anchor>
  ) : (
    <Anchor href={href} target="_blank" rel="noreferrer" inherit>
      {children}
    </Anchor>
  );
}
