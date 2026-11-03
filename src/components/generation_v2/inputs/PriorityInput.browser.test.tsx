import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { PriorityInput } from '~/components/generation_v2/inputs/PriorityInput';
import type { PriorityOption } from '~/components/generation_v2/inputs/PriorityInput';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';

// The mobile generator comes from the flag and media queries, which the test browser can't set.
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => true,
  useGeneratorLayout: () => 'mobile',
}));
// The membership offer's module graph reaches @prisma/client; only where it renders matters here.
vi.mock('~/components/RequireMembership/RequireMembership', () => ({
  RequireMembership: ({ children }: { children: ReactNode }) => (
    <div data-testid="membership-offer">{children}</div>
  ),
}));
vi.mock('~/components/SupportButton/SupportButton', () => ({
  SupportButtonPolymorphic: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

const options: PriorityOption[] = [
  { label: 'Standard', value: 'low', offset: 0 },
  { label: 'High', value: 'normal', offset: 10 },
  { label: 'Highest', value: 'high', offset: 20, memberOnly: true },
];

describe('PriorityInput in the mobile generator', () => {
  test('the priorities open in a sheet, and picking one reports it and closes the sheet', async () => {
    const onChange = vi.fn();
    renderWithProviders(<PriorityInput value="low" options={options} onChange={onChange} />);
    await page.getByRole('button', { name: 'Request Priority: Standard' }).click();

    const sheet = page.getByRole('dialog', { name: 'Request Priority' });
    await sheet.getByRole('menuitemradio', { name: /^High(?!est)/ }).click();
    expect(onChange).toHaveBeenCalledWith('normal');
    await expect.element(sheet).not.toBeInTheDocument();
  });

  test('a member-only priority offers the membership to a non-member instead', async () => {
    renderWithProviders(<PriorityInput value="low" options={options} onChange={vi.fn()} />);
    await page.getByRole('button', { name: 'Request Priority: Standard' }).click();

    const sheet = page.getByRole('dialog', { name: 'Request Priority' });
    await expect.element(sheet.getByTestId('membership-offer')).toHaveTextContent(/Highest/);
    await expect
      .element(sheet.getByRole('menuitemradio', { name: /Highest/ }))
      .not.toBeInTheDocument();
  });

  test('a member picks a member-only priority like any other', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PriorityInput value="low" options={options} isMember onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Request Priority: Standard' }).click();

    const sheet = page.getByRole('dialog', { name: 'Request Priority' });
    await expect.element(sheet.getByTestId('membership-offer')).not.toBeInTheDocument();
    await sheet.getByRole('menuitemradio', { name: /Highest/ }).click();
    expect(onChange).toHaveBeenCalledWith('high');
  });
});
