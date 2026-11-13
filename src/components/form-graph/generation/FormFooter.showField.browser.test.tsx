import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { ShowFieldButton } from '~/components/form-graph/generation/FormFooter';

/**
 * A footer alert about a missing field offers to take the viewer to that field, which can be a long
 * way up the form. Only fields that mark themselves with `data-generation-field` are reachable.
 */
describe('ShowFieldButton', () => {
  test('scrolls to the field as it is now, after the field remounted', async () => {
    renderWithProviders(
      <div>
        <div data-testid="form">
          <div data-generation-field="images">Source images</div>
        </div>
        <ShowFieldButton fieldKey="images" />
      </div>
    );
    await expect.element(page.getByRole('button', { name: 'Show' })).toBeVisible();
    // A workflow change remounts the field: the button must find the new one, not the one it saw.
    const remounted = document.createElement('div');
    remounted.setAttribute('data-generation-field', 'images');
    document.querySelector('[data-testid="form"]')!.replaceChildren(remounted);
    const scroll = vi.spyOn(remounted, 'scrollIntoView');

    await page.getByRole('button', { name: 'Show' }).click();
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  test('offers nothing for a field that is not on the page', async () => {
    renderWithProviders(
      <div>
        <span>ready</span>
        <ShowFieldButton fieldKey="video" />
      </div>
    );
    await expect.element(page.getByText('ready')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Show' })).not.toBeInTheDocument();
  });
});
