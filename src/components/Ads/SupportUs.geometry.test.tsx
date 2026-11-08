import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { renderAtViewport } from '../../../test/geometry-setup';
import { SupportUs } from './SupportUs';

/**
 * The banner sits in a full-width row in place of an ad. Only the image may link to /pricing: the
 * blank background beside it reads as page, and a click or middle-click there must not navigate.
 */
let followed: number;
const onClick = (event: MouseEvent) => {
  if ((event.target as Element).closest('a[href="/pricing"]')) followed++;
  event.preventDefault();
};

beforeEach(() => {
  followed = 0;
  document.addEventListener('click', onClick);
});
afterEach(() => {
  document.removeEventListener('click', onClick);
  cleanup();
});

async function renderRow() {
  // A desktop-wide row, as on the home page between blocks.
  await renderAtViewport(<SupportUs maxWidth={970} maxHeight={250} />, {
    width: 1600,
    height: 900,
  });
  const image = page.getByRole('img', { name: 'Support Civitai creators' });
  await expect.element(image).toBeVisible();
  return image.element().getBoundingClientRect();
}

describe('SupportUs', () => {
  it('links only the image, not the blank row beside it', async () => {
    const image = await renderRow();
    const link = document.querySelector('a[href="/pricing"]')!.getBoundingClientRect();
    expect(link.width).toBe(image.width);

    // The left gutter, level with the image.
    const body = document.body.getBoundingClientRect();
    await userEvent.click(document.body, {
      position: { x: image.left / 2 - body.left, y: image.top + image.height / 2 - body.top },
    });
    expect(followed).toBe(0);
  });

  it('still links from the image', async () => {
    await renderRow();

    await userEvent.click(page.getByRole('img', { name: 'Support Civitai creators' }));

    expect(followed).toBe(1);
  });
});
