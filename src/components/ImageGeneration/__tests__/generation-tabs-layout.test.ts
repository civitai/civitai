import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getGenerationPanelLayout } from '~/components/ImageGeneration/generation-tabs-layout';

// Justin, 2026-09-24: "I don't see any way to access the filters on mobile. The filter
// buttons are hidden." On a phone at /generate the sort control, the Filters button and
// Select all were all absent — the panel had suppressed its own actions row because the
// PAGE renders one, without accounting for the panel going fullscreen over that page.

const at = (isGeneratePage: boolean, fullScreen: boolean) =>
  getGenerationPanelLayout({ isGeneratePage, fullScreen, view: 'queue' });

describe('getGenerationPanelLayout', () => {
  it('gives the fullscreen panel the results, page or not', () => {
    // The finding. A phone is always fullScreen, so /generate returned false here.
    expect(at(true, true).showResults).toBe(true);
    expect(at(true, true).imageFeedSeparate).toBe(false);
  });

  it('leaves the results to the page when the panel is a sidebar beside it', () => {
    // The control. Without it the case above passes against a build that renders the
    // row unconditionally — which duplicates the page's copy on desktop.
    expect(at(true, false).showResults).toBe(false);
    expect(at(true, false).imageFeedSeparate).toBe(true);
  });

  it('gives the panel the results off /generate at either width', () => {
    expect(at(false, true).showResults).toBe(true);
    expect(at(false, false).showResults).toBe(true);
  });

  it('withholds the results while the generate form is the view', () => {
    // The row acts on queue/feed items; there are none to sort or filter here.
    expect(
      getGenerationPanelLayout({ isGeneratePage: false, fullScreen: true, view: 'generate' })
        .showResults
    ).toBe(false);
  });

  // The cases above pin the RULE. They stay green against a GenerationTabs that
  // reaches past it and re-derives the gate by hand, which is the bug itself — the
  // row and the views it acts on were two expressions, and only one knew about
  // fullscreen. So pin that they are one expression.
  it('is what GenerationTabs gates its results actions row on', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../GenerationTabs.tsx'), 'utf8');
    expect(src).toContain('{showResults && <GeneratedImageActions />}');
  });
});
