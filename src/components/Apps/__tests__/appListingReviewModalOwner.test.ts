import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE LISTING DETAIL PAGE MOUNTS EXACTLY ONE REVIEW MODAL.
 *
 * Three entry points open it: the `⋮` item, the Reviews-heading button and the
 * empty-state button. The body owns the one `ReviewListingModal` and passes
 * `onOpenReview` to the shared menu, which then skips mounting its own.
 *
 * STRUCTURAL, and labelled as such: a closed Mantine `Modal` renders nothing, so the
 * browser tier cannot tell "one instance" from "two instances, one open". This pins the
 * source shape that makes a second copy impossible on this page.
 */

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const BODY = read('components/Apps/AppListingDetailBody.tsx');
const MENU = read('components/Apps/AppListingActionsMenu.tsx');

describe('one review modal on the listing detail page', () => {
  it('the detail body mounts ReviewListingModal exactly once', () => {
    expect([...BODY.matchAll(/<ReviewListingModal[\s/>]/g)]).toHaveLength(1);
  });

  it('the body hands the menu its opener', () => {
    const menuCall = BODY.match(/<AppListingActionsMenu[\s\S]*?\/>/);
    // Positive control: the extractor found the call at all.
    expect(menuCall?.[0]).toContain('surface="detail"');
    expect(menuCall?.[0]).toMatch(/onOpenReview=\{reviewModal\.open\}/);
  });

  it('the menu does not mount its own modal when the caller owns one', () => {
    const mounts = [...MENU.matchAll(/\{([^{}]*)&&\s*\(\s*<ReviewListingModal[\s/>]/g)];
    expect(mounts).toHaveLength(1);
    expect(mounts[0][1]).toMatch(/!onOpenReview/);
  });
});
