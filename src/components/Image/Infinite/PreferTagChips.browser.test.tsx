import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { PreferTagChips } from '~/components/Image/Infinite/MoreLikeThisPrefer';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const anchorTags = [
  { id: 1676, name: 'monochrome' },
  { id: 5, name: 'otter' },
];

describe('PreferTagChips', () => {
  test("tapping one of the anchor's tags prefers it", async () => {
    const onPrefer = vi.fn();
    renderWithProviders(<PreferTagChips anchorTags={anchorTags} onPrefer={onPrefer} />);
    await page.getByText('monochrome').click();
    expect(onPrefer).toHaveBeenLastCalledWith(1676);
  });

  test('tapping the preferred tag again stops preferring it', async () => {
    const onPrefer = vi.fn();
    renderWithProviders(
      <PreferTagChips anchorTags={anchorTags} preferTagId={1676} onPrefer={onPrefer} />
    );
    await page.getByText('monochrome').click();
    expect(onPrefer).toHaveBeenLastCalledWith(undefined);
  });

  test("a preferred tag from a link that is not the anchor's can be removed", async () => {
    const onPrefer = vi.fn();
    renderWithProviders(
      <PreferTagChips anchorTags={anchorTags} preferTagId={999} onPrefer={onPrefer} />
    );
    await expect.element(page.getByText('A preferred tag')).toBeVisible();
    const pill = page.getByText('A preferred tag').element().closest('.mantine-Pill-root');
    (pill?.querySelector('button') as HTMLButtonElement).click();
    expect(onPrefer).toHaveBeenLastCalledWith(undefined);
  });
});
