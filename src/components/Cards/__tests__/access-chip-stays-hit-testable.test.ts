import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The access chip must take pointer events, or it does nothing it exists to do.
 *
 * `AspectRatioCard`'s header is `pointer-events: none` so the chips in it fall through to the card's
 * image link. The card TEMPLATE re-enables it on its own `.chip`; `Cards.module.css`'s `.chip` —
 * the one every card under `src/components/Cards/` uses — does not. So the access chip carries
 * `pointer-events-auto` at the call site, and without it BOTH the tooltip trigger and the chip's own
 * link die: a glyph nothing explains, over a link nothing can click.
 *
 * 🔴 WHY THIS IS A SOURCE SCAN. The component harness loads no stylesheet, so the class has no
 * observable effect there — `userEvent.hover` reaches an unstyled element whether or not it would be
 * hit-testable in a browser. Deleting the class leaves `ModelCard.browser.test.tsx` fully green,
 * including both tooltip tests. Nothing that renders can see this; only reading the source can.
 */
const modelCard = () => readFileSync(resolve(__dirname, '..', 'ModelCard.tsx'), 'utf-8');

describe('the access chip stays hit-testable', () => {
  test('the chip carries pointer-events-auto at its call site', () => {
    const source = modelCard();

    // The positive control: if the chip cannot be found at all — renamed, restructured, moved to
    // another file — that is a failure, not a pass.
    // `slice(-1)` on a missing match yields the LAST CHARACTER, not '', so a `not.toBe('')` control
    // here could never fire. Assert the index instead.
    const start = source.indexOf('function AccessChip');
    expect(start, 'AccessChip is gone from ModelCard.tsx').toBeGreaterThan(-1);
    const chip = source.slice(start);
    expect(chip).toContain('data-status-badge="access"');

    expect(
      chip.slice(0, chip.indexOf('data-status-badge="access"')),
      'the access chip lost `pointer-events-auto`, so its header makes it untouchable: no tooltip, no click'
    ).toContain('pointer-events-auto');
  });

  test('the `.chip` the card actually uses still does not re-enable pointer events', () => {
    // If this ever fails, read it as a regression to revert rather than a signal to drop the
    // call-site class: ~20 decorative chips across ArticleCard, BountyCard and ChallengeCard wear
    // this same `.chip` and WANT to fall through to the card link.
    const cardsCss = readFileSync(resolve(__dirname, '..', 'Cards.module.css'), 'utf-8');
    const chipRule = cardsCss.slice(cardsCss.indexOf('.chip {'));
    expect(chipRule.slice(0, chipRule.indexOf('}'))).not.toContain('pointer-events');
  });
});
