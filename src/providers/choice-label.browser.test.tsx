import { Checkbox, MantineProvider, Radio } from '@mantine/core';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../test/component-setup';
import { theme } from '~/providers/ThemeProvider';

// The scaffold's MantineProvider has the default theme; the app's is what adds this behaviour.
function renderWithTheme(ui: React.ReactNode) {
  renderWithProviders(<MantineProvider theme={theme}>{ui}</MantineProvider>);
}

describe('checkbox and radio descriptions', () => {
  test("tapping a checkbox's description toggles it", async () => {
    const onChange = vi.fn();
    renderWithTheme(
      <Checkbox
        label="Enhanced Compatibility"
        description="Older prompts look more like the originals"
        onChange={onChange}
      />
    );
    // Forced: the label's click area covers the text, which is the point; a real tap lands there.
    await page.getByText('Older prompts look more like the originals').click({ force: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole('checkbox')).toBeChecked();
  });

  test("tapping a radio's description selects it", async () => {
    renderWithTheme(<Radio label="Turbo" description="Fewer steps, faster" />);
    await page.getByText('Fewer steps, faster').click({ force: true });
    await expect.element(page.getByRole('radio')).toBeChecked();
  });

  test('a link in the description still follows the link, not the checkbox', async () => {
    const onLink = vi.fn((e: React.MouseEvent) => e.preventDefault());
    renderWithTheme(
      <Checkbox
        label="Accept"
        description={
          <>
            Read the{' '}
            <a href="/terms" onClick={onLink}>
              terms
            </a>
          </>
        }
      />
    );
    await page.getByRole('link', { name: 'terms' }).click();
    expect(onLink).toHaveBeenCalled();
    await expect.element(page.getByRole('checkbox')).not.toBeChecked();
  });
});
