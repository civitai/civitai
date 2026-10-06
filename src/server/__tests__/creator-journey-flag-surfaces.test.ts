import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The Creator Journey gates that are one condition at a declaration, pinned by text because rendering
 * them needs the whole app shell. These see the declaration, not the value in use; the behaviour of
 * each flag-off path is pinned in creator-journey-page, CreatorScoreGateMessage and
 * update-user-score-tier-grants tests.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Creator Journey flag gates', () => {
  it('refuses every journey procedure without the flag', () => {
    const router = read('src/server/routers/creator-journey.router.ts');
    const procedures = router.match(/^ {2}\w+: (public|protected)Procedure$/gm) ?? [];
    expect(procedures).toHaveLength(3);
    expect(router.match(/\.use\(isFlagProtected\('creatorJourney'\)\)/g)).toHaveLength(
      procedures.length
    );
  });

  it('keeps getLadder out of the edge cache, which would serve it past the flag', () => {
    expect(read('src/server/routers/creator-journey.router.ts')).not.toContain('edgeCacheIt');
    expect(read('src/utils/trpc.ts')).not.toContain("'creatorJourney.getLadder'");
  });

  it('shows the user-menu entry only with the flag', () => {
    const hooks = read('src/components/AppLayout/AppHeader/hooks.tsx');
    expect(hooks).toMatch(
      /href: CREATOR_JOURNEY_HREF,\s*visible: !!currentUser && features\.creatorJourney,/
    );
  });

  it('renders the score card journey link only with the flag', () => {
    const card = read('src/components/Account/StrikesCard.tsx');
    expect(card.match(/<CreatorJourneyCardLink /g)).toHaveLength(2);
    expect(
      card.match(
        /\{features\.creatorJourney && <CreatorJourneyCardLink meta=\{currentUser\?\.meta\} \/>\}/g
      )
    ).toHaveLength(2);
  });
});
