import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import { SearchSortLock } from './SearchSortLock';

test('a tap on the locked sort lands on the wrapper, not the disabled button', async () => {
  await renderAtViewport(<SearchSortLock />, PHONE_VIEWPORT);
  const button = page.getByRole('button', { name: 'Best match' });
  await expect.element(button).toBeDisabled();

  const { x, y, width, height } = button.element().getBoundingClientRect();
  expect(document.elementFromPoint(x + width / 2, y + height / 2)).toBe(
    button.element().parentElement
  );
});
