import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The access chip must take pointer events, and must not prefetch.
 *
 * `AspectRatioCard`'s header is `pointer-events: none` so the chips in it fall through to the card's
 * image link. The card TEMPLATE re-enables it on its own `.chip`; `Cards.module.css`'s `.chip` — the
 * one every card under `src/components/Cards/` uses — does not. So the chip carries
 * `pointer-events-auto` at the call site, and without it BOTH the tooltip trigger and the chip's own
 * link die: a glyph nothing explains, over a link nothing can click.
 *
 * 🔴 WHY THESE ARE SOURCE SCANS. The component harness loads no stylesheet, so the class has no
 * observable effect there — deleting it leaves `ModelCard.browser.test.tsx` fully green, both
 * tooltip tests included. The prefetch is worse: nothing renderable can see it at all, and it was
 * measured at 39 route chunks the feed does not already have, 585,542 bytes, evaluated on the feed's
 * main thread once per session. Only reading the source catches either.
 */
const modelCard = () => readFileSync(resolve(__dirname, '..', 'ModelCard.tsx'), 'utf-8');

/** The chip's `<Badge …>` opening tag, so assertions are free of prop ORDER. */
function badgeTag(source: string) {
  const chipAt = source.indexOf('function AccessChip');
  expect(chipAt, 'AccessChip is gone from ModelCard.tsx').toBeGreaterThan(-1);

  const open = source.indexOf('<Badge', chipAt);
  expect(open, 'AccessChip no longer renders a Badge').toBeGreaterThan(-1);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    else if (source[i] === '>' && !depth) return source.slice(open, i + 1);
  }
  throw new Error('unterminated <Badge> tag in AccessChip');
}

describe('the access chip stays hit-testable', () => {
  test('the chip carries pointer-events-auto on the badge itself', () => {
    const tag = badgeTag(modelCard());

    // Scoped to the one tag, not to a prefix of the component: a prefix window is prop-ORDER
    // dependent, so reordering two attributes reddens it while the class sits three lines below —
    // a false red carrying an actively wrong diagnosis.
    expect(tag).toContain('data-status-badge="access"');
    expect(
      tag,
      'the access chip lost `pointer-events-auto`, so its header makes it untouchable: no tooltip, no click'
    ).toContain('pointer-events-auto');
  });

  test('the chip links through NextLink, which is the wrapper that disables prefetch', () => {
    const source = modelCard();

    // `next/link` prefetches on viewport entry in the pages router. `~/components/NextLink` exists
    // to turn that off and is what the card's own link uses; a raw import here pulled the
    // model-detail route graph on every feed session. Nothing rendered can observe the difference —
    // both spellings produce an `<a>` with the same href.
    expect(badgeTag(source)).toContain('component={NextLink}');
    expect(source, 'a raw `next/link` import is back, and it prefetches').not.toContain(
      "from 'next/link'"
    );
  });

  test('the `.chip` the card actually uses still does not re-enable pointer events', () => {
    const cardsCss = readFileSync(resolve(__dirname, '..', 'Cards.module.css'), 'utf-8');

    // Brace-balanced, and asserted to have been FOUND. Slicing to the first `}` stops at the nested
    // `> *` block's closer, so a `pointer-events` appended to the end of `.chip` sits outside the
    // window and passes; and a `.chip{` respelling makes the window empty, which also passes.
    const open = cardsCss.indexOf('.chip {');
    expect(open, 'no `.chip` rule found in Cards.module.css').toBeGreaterThan(-1);

    let depth = 0;
    let rule = '';
    for (let i = cardsCss.indexOf('{', open); i < cardsCss.length; i += 1) {
      if (cardsCss[i] === '{') depth += 1;
      else if (cardsCss[i] === '}') {
        depth -= 1;
        if (!depth) {
          rule = cardsCss.slice(open, i + 1);
          break;
        }
      }
    }
    expect(rule, 'could not find the end of the `.chip` rule').not.toBe('');

    // If this fails, read it as a regression to revert rather than a signal to drop the call-site
    // class: ~20 decorative chips across ArticleCard, BountyCard and ChallengeCard wear this same
    // `.chip` and want to keep falling through to the card link.
    expect(rule).not.toContain('pointer-events');
  });
});
