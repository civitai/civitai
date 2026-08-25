import { describe, expect, it } from 'vitest';
import { STRIKE_REASONS, TOS_REASONS, type CannedReason } from '$lib/moderation-reasons';

/**
 * `tos` is what lets a struck user be shown WHICH terms they broke. Two properties of it are easy to
 * break by writing an obvious-looking value, and neither typechecks into anything visible:
 * a lettered citation is wrong on half the domains, and a citation on `Non AI content` asserts a rule
 * the ToS does not contain.
 */
const all: CannedReason[] = [...STRIKE_REASONS, ...TOS_REASONS];

describe('canned reason ToS citations', () => {
  it('cites a section, never a lettered bullet', () => {
    // `tos.green.md` inserts a clause at 9.6(a) and pushes the rest down, so 9.6(a) on civitai.com is
    // 9.6(b) on green. Sections match across variants; letters do not.
    for (const reason of all) {
      if (!reason.tos) continue;
      expect(
        reason.tos,
        `"${reason.label}" cites a lettered bullet, which differs per domain`
      ).toMatch(/^\d+\.\d+$/);
    }
  });

  it('leaves "Non AI content" uncited, because the ToS does not require content to be AI-generated', () => {
    // The moderation team decided this deliberately on 2026-08-24 rather than add a clause. A citation
    // appearing here later means someone assumed one exists — check the ToS before trusting it.
    for (const reason of all.filter((r) => r.label === 'Non AI content')) {
      expect(reason.tos).toBeUndefined();
    }
    expect(all.filter((r) => r.label === 'Non AI content')).toHaveLength(2);
  });

  it('cites the prohibited-content section for every reason that has one', () => {
    // Everything a moderator can pick today is prohibited content; §11 covers conduct (harassment,
    // multi-accounting) which only ever arrives as free text. If a conduct reason is ever added to a
    // picker this fails, which is the moment to decide whether the modal can anchor §11 too.
    const cited = all.filter((r) => r.tos).map((r) => r.tos);
    expect(new Set(cited)).toEqual(new Set(['9.6']));
  });
});
