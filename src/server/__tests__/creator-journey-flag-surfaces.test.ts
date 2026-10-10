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

const OWNER_FLAGGED = 'isMilestoneShareable';

describe('Creator Journey flag gates', () => {
  it('refuses every journey procedure without the flag', () => {
    const router = read('src/server/routers/creator-journey.router.ts').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      ''
    );
    // One chunk per procedure, whatever kind of procedure it is or how it is written.
    const procedures = router.split(/^ {2}(?=\w+: \w+Procedure(?!\w))/m).slice(1);
    expect(procedures).toHaveLength(7);
    const gated = procedures.filter((procedure) => !procedure.startsWith(`${OWNER_FLAGGED}:`));
    expect(gated).toHaveLength(6);
    for (const procedure of gated) {
      expect(procedure, procedure.split(':')[0]).toContain(
        ".use(isFlagProtected('creatorJourney'))"
      );
    }
  });

  // Its caller is a link-preview crawler, which has no flag of its own, so the card's OWNER must have
  // the flag instead. Do not put it behind the viewer's flag: every share link would preview nothing.
  it(`checks the owner's flag, not the viewer's, in ${OWNER_FLAGGED}`, () => {
    const router = read('src/server/routers/creator-journey.router.ts');
    const procedure = router.slice(router.indexOf(`${OWNER_FLAGGED}:`)).split(/\n {2}\w+: /)[0];
    expect(procedure).toContain('isMilestoneShareable(input)');
    expect(procedure).not.toContain('isFlagProtected');
    expect(read('src/server/services/creator-milestone-share.service.ts')).toMatch(
      /if \(!\(await isCreatorJourneyOnFor\(\{ id: userId, isModerator: row\.isModerator \}\)\)\) return \[\];/
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
