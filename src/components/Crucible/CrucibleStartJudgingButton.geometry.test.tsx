import { describe, expect, test } from 'vitest';
import { box, cascadeEvidence, renderAtViewport } from '../../../test/geometry-setup';
import { CrucibleStartJudgingButton } from '~/components/Crucible/CrucibleStartJudgingButton';

describe('CrucibleStartJudgingButton', () => {
  test("keeps the label's descenders inside the box that clips it", async () => {
    await renderAtViewport(<CrucibleStartJudgingButton onClick={() => undefined} />);

    expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(
      true
    );

    const label = document.querySelector('.mantine-Button-label');
    if (!label) throw new Error('button label did not render');
    expect(getComputedStyle(label).overflow).toBe('hidden');

    const text = Array.from(label.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (!text) throw new Error('label has no text node');
    const range = document.createRange();
    range.selectNodeContents(text);
    const glyphs = range.getBoundingClientRect();
    const clip = box(label);

    expect(glyphs.height).toBeGreaterThan(0);
    expect(Math.round(glyphs.bottom * 100) / 100).toBeLessThanOrEqual(clip.bottom);
    expect(Math.round(glyphs.top * 100) / 100).toBeGreaterThanOrEqual(clip.top);
  });
});
