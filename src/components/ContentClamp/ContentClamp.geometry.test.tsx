import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { PHONE_VIEWPORT, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import { ContentClamp } from './ContentClamp';

// A user's browser default font size sets the root font size. Mantine converts px to rem
// assuming 16, so anything it measures in px and writes back through rem() drifts off 16.
const LINES = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`);

function renderClamp() {
  return renderAtViewport(
    <ContentClamp maxHeight={100}>
      <div data-testid="clamp-content">
        {LINES.map((l) => (
          <p key={l} style={{ margin: 0, height: 20 }}>
            {l}
          </p>
        ))}
      </div>
    </ContentClamp>,
    PHONE_VIEWPORT
  );
}

const region = () => document.querySelector<HTMLElement>('[role="region"]')!;
const content = () => document.querySelector<HTMLElement>('[data-testid="clamp-content"]')!;

async function expand() {
  await page.getByRole('button', { name: 'Show More' }).click();
  await nextLayout();
  // open height is written from a ResizeObserver measurement, so let it settle
  await new Promise((r) => setTimeout(r, 350));
}

afterEach(() => {
  document.documentElement.style.fontSize = '';
});

describe.each([12, 16, 20])('ContentClamp with a %ipx root font size', (rootPx) => {
  test('expanded region fits its content exactly (no clipping, no dead space)', async () => {
    document.documentElement.style.fontSize = `${rootPx}px`;
    await renderClamp();
    expect(parseFloat(getComputedStyle(document.documentElement).fontSize)).toBe(rootPx);
    await expand();
    expect(Math.round(region().getBoundingClientRect().height)).toBe(
      Math.round(content().getBoundingClientRect().height)
    );
  });

  test('collapsed region is 100px tall', async () => {
    document.documentElement.style.fontSize = `${rootPx}px`;
    await renderClamp();
    expect(Math.round(region().getBoundingClientRect().height)).toBe(100);
  });
});
