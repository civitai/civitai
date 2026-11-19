import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { PartnerDisclosureIcons } from '~/components/generation_v2/PartnerDisclosureIcons';

const PARTNER =
  'A partner runs this model. Your prompt and files go to the partner to create your result.';
const TRAINS =
  "This partner may use your prompt and results to improve its models. Don't include anything private.";

const icon = (text: string) => page.getByRole('button', { name: text, exact: true });

describe('PartnerDisclosureIcons', () => {
  test('shows nothing for a version no partner runs, even with the trains bit', async () => {
    renderWithProviders(
      <div data-testid="host">
        <PartnerDisclosureIcons partnerService={false} partnerTrains />
      </div>
    );
    await expect.element(page.getByTestId('host')).toBeEmptyDOMElement();
  });

  test('a partner version shows only the partner icon', async () => {
    renderWithProviders(<PartnerDisclosureIcons partnerService />);
    await expect.element(icon(PARTNER)).toBeInTheDocument();
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
  });

  test('a tap opens the exact text and does not reach the card it sits in', async () => {
    const onCardClick = vi.fn();
    renderWithProviders(
      <button type="button" onClick={onCardClick}>
        <PartnerDisclosureIcons partnerService partnerTrains />
      </button>
    );
    await icon(TRAINS).click();
    const dropdown = page.getByText(TRAINS, { exact: true });
    await expect.element(dropdown).toBeVisible();
    expect(document.querySelector('.mantine-Popover-dropdown')?.textContent).toBe(TRAINS);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  test('hover opens the text and leaving closes it', async () => {
    renderWithProviders(<PartnerDisclosureIcons partnerService />);
    await userEvent.hover(icon(PARTNER));
    await expect.element(page.getByText(PARTNER, { exact: true })).toBeVisible();
    await userEvent.unhover(icon(PARTNER));
    await expect.element(page.getByText(PARTNER, { exact: true })).not.toBeInTheDocument();
  });
});
