import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';
import { classOf, hasAttr, type SvelteTag, walkTags } from '../test/svelte-tags';

/**
 * ⚠️ A TEXT PIN OVER FOUR NAMED ELEMENTS. Nothing renders and no pixel is measured: this suite
 * runs in Node with no layout engine.
 *
 * Each element made its page scroll sideways at a 390px viewport (a phone):
 *   - `/articles/unpublished`: the violation-reason box held one unbreakable token (a pasted URL).
 *   - `/ratings`: the `whitespace-pre-wrap` user and moderator text, same cause.
 *   - `/feedback`: the Area select's nowrap label pushed its chevron past the trigger's edge.
 *   - `/audit/training-models`: the card is a grid item with `min-width: auto`, so the nowrap
 *     `truncate` file and version names set the card's minimum width and nothing truncated; a long
 *     username in its `shrink-0` link did the same to the header row.
 * Each fix was measured in a browser (real markup, the app's real CSS, 390px) before this pin
 * was written.
 *
 * 🔴 WHAT IT CANNOT SEE. It reads the markup as text: a different element that overflows, or a
 * breaking class applied from a child component or computed in script, is invisible to it. It
 * pins these four places and says nothing about any other page.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => stripComments(readFileSync(path.resolve(dir, '..', p), 'utf8'));

const has = (cls: string | null, token: string) => (cls ?? '').split(/\s+/).includes(token);
// Only the two that also lower the element's MIN-CONTENT width. `break-words` / `wrap-break-word`
// (`overflow-wrap: break-word`) do not, so inside a flex or grid item sized by its content they
// leave the overflow in place.
const WRAPS = ['wrap-anywhere', 'break-all'];
const breaks = (cls: string | null) => WRAPS.some((w) => has(cls, w));

function find(file: string, match: (tag: SvelteTag, ancestors: readonly SvelteTag[]) => boolean) {
  const out: { tag: SvelteTag; ancestors: readonly SvelteTag[] }[] = [];
  walkTags(read(file), (tag, ancestors) => {
    if (match(tag, ancestors)) out.push({ tag, ancestors: [...ancestors] });
  });
  return out;
}

describe('390px: user text and labels cannot widen the page', () => {
  it('/articles/unpublished: the violation reason breaks inside its box', () => {
    const boxes = find('routes/articles/unpublished/+page.svelte', (t) =>
      has(classOf(t), 'border-red-500/30')
    );
    expect(boxes.length).toBe(1);
    expect(breaks(classOf(boxes[0].tag))).toBe(true);
  });

  it('/ratings: every pre-wrapped user or moderator text also breaks long tokens', () => {
    const texts = [
      'routes/ratings/RatingDisputeDetail.svelte',
      'routes/ratings/ScannedTextCard.svelte',
    ].flatMap((file) =>
      // HighlightedText renders the pre-wrapped text; its breaking class is passed in from here.
      find(file, (t) => has(classOf(t), 'whitespace-pre-wrap') || t.name === 'HighlightedText')
    );
    expect(texts.length).toBe(4);
    for (const { tag } of texts) expect(breaks(classOf(tag)), tag.raw).toBe(true);
  });

  it('/feedback: the Area select truncates its label inside a trigger capped at its container', () => {
    const file = 'routes/feedback/FeedbackFilters.svelte';
    const isTrigger = (t: SvelteTag) => t.name === 'Select.Trigger' && hasAttr(t, 'id');
    const triggers = find(file, isTrigger);
    expect(triggers.length).toBe(1);
    expect(has(classOf(triggers[0].tag), 'max-w-full')).toBe(true);
    const labels = find(
      file,
      (t, ancestors) =>
        ancestors.some(isTrigger) && has(classOf(t), 'truncate') && has(classOf(t), 'min-w-0')
    );
    expect(labels.length).toBe(1);
  });

  it('/audit/training-models: the card can shrink below its content, and so can the username', () => {
    const file = 'routes/audit/training-models/TrainingModelCard.svelte';
    const cards = find(file, (t) => t.name === 'article');
    expect(cards.length).toBe(1);
    expect(has(classOf(cards[0].tag), 'min-w-0')).toBe(true);

    const isUserLink = (t: SvelteTag) => t.name === 'a' && t.attrs.includes('userLookupUrl(');
    const links = find(file, isUserLink);
    expect(links.length).toBe(1);
    const cls = classOf(links[0].tag) ?? '';
    // The link needs a width cap with or without `shrink-0`: its automatic minimum width is the
    // unwrapped username, so dropping `shrink-0` alone still pins the row (measured: 501px at 390).
    expect(cls).toMatch(/(^|\s)max-w-\S+/);
    const names = find(
      file,
      (t, ancestors) => ancestors.some(isUserLink) && has(classOf(t), 'truncate')
    );
    expect(names.length).toBe(1);
  });
});
