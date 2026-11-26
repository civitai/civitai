import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import { ImageReactionCount } from '~/components/Post/EditV2/PostImageCards/ImageReactionCount';

describe('ImageReactionCount', () => {
  test('shows the count, including zero', async () => {
    renderWithProviders(
      <>
        <ImageReactionCount count={12} />
        <ImageReactionCount count={0} />
      </>
    );
    await expect.element(page.getByLabelText('12 reactions')).toHaveTextContent('12');
    await expect.element(page.getByLabelText('0 reactions')).toHaveTextContent('0');
  });

  test('renders nothing when the count is unknown', async () => {
    renderWithProviders(
      <div data-testid="box">
        <ImageReactionCount count={undefined} />
        <ImageReactionCount count={null} />
      </div>
    );
    await expect.element(page.getByTestId('box')).toBeEmptyDOMElement();
  });
});
