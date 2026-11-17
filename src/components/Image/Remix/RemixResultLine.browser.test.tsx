import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { RemixResultLine } from '~/components/Image/Remix/RemixResultLine';

describe('RemixResultLine', () => {
  test('reads Remix again, Open in queue, the gallery switch with its price, then Post', async () => {
    renderWithProviders(
      <RemixResultLine
        onRemixAgain={vi.fn()}
        onOpenQueue={vi.fn()}
        gallery={{ checked: true, onChange: vi.fn(), price: 'free' }}
        onPost={vi.fn()}
      />
    );
    const line = page.getByTestId('remix-result-line');
    await expect.element(line).toBeVisible();

    const controls = [...line.element().querySelectorAll('button, input[type="checkbox"]')].map(
      (el) =>
        el instanceof HTMLInputElement
          ? `switch:${el.closest('label')?.textContent ?? el.labels?.[0]?.textContent}`
          : el.getAttribute('aria-label') ?? el.textContent
    );
    expect(controls).toEqual([
      'Remix again',
      'Open in queue',
      'switch:Remix gallery · free',
      'Post',
    ]);
  });
});
