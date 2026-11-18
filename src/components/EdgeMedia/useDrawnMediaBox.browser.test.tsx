import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { useDrawnMediaBox } from '~/components/EdgeMedia/useDrawnMediaBox';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The detail view's media is centred in its container, and the sticker timeline pads the
 * container's bottom. Media limited by width then moves up without changing size.
 */
function Harness() {
  const [padded, setPadded] = useState(false);
  const { hostRef, box } = useDrawnMediaBox(true);
  return (
    <>
      <button onClick={() => setPadded(true)}>Pad</button>
      <div
        style={{
          position: 'relative',
          width: 600,
          height: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBottom: padded ? 132 : 0,
          boxSizing: 'border-box',
        }}
      >
        <div data-testid="media" style={{ width: 400, height: 300 }} />
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
      <output data-testid="top">{box ? box.top : 'none'}</output>
    </>
  );
}

describe('the drawn media box', () => {
  test('follows media that moves without changing size, so a placement is saved against where it is', async () => {
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('top')).toHaveTextContent('150');

    await page.getByRole('button', { name: 'Pad' }).click();

    await expect.element(page.getByTestId('top')).toHaveTextContent('84');
  });
});
