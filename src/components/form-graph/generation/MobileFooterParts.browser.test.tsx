import { Alert, Button } from '@mantine/core';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { QuantityPicker } from '~/components/form-graph/generation/MobileFooterParts';
import { FooterStrips, footerStripsFrame } from '~/components/generation_v2/FooterStrips';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';

// The phone layout comes from the flag and media queries, which the test browser can't set.
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => true,
  useGeneratorLayout: () => 'mobile',
}));

describe('QuantityPicker', () => {
  test("offers the tier's quantities in its steps and reports the one picked", async () => {
    const onChange = vi.fn();
    renderWithProviders(<QuantityPicker value={4} min={2} max={8} step={2} onChange={onChange} />);
    await page.getByRole('button', { name: 'Quantity: 4' }).click();

    const sheet = page.getByRole('dialog', { name: 'Quantity' });
    const choices = (await sheet.getByRole('button').all())
      .map((choice) => choice.element())
      .filter((el) => el.hasAttribute('aria-pressed'));
    expect(choices.map((el) => el.textContent)).toEqual(['2', '4', '6', '8']);
    await expect
      .element(sheet.getByRole('button', { name: '4' }))
      .toHaveAttribute('aria-pressed', 'true');

    await sheet.getByRole('button', { name: '8' }).click();
    expect(onChange).toHaveBeenCalledWith(8);
    await expect.element(sheet).not.toBeInTheDocument();
  });

  test('shows what an upgrade unlocks, locked', async () => {
    renderWithProviders(
      <QuantityPicker value={1} min={1} max={2} step={1} upsellMax={4} onChange={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Quantity: 1' }).click();

    await expect.element(page.getByRole('button', { name: '3' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: '2' })).toBeEnabled();
    await expect.element(page.getByText(/Your tier allows 2 per request/)).toBeInTheDocument();
  });
});

describe('FooterStrips', () => {
  test('a tap opens a strip to its full text; its own buttons still act', async () => {
    const onAct = vi.fn();
    renderWithProviders(
      <FooterStrips>
        <div data-testid="strip">
          <p>
            <span data-testid="strip-text">A long notice</span>
          </p>
          <Button onClick={onAct}>Switch</Button>
        </div>
      </FooterStrips>
    );
    const strip = page.getByTestId('strip');
    await expect.element(strip).toBeInTheDocument();
    // A tap lands on the strip's text, deep inside it; the strip itself is what opens.
    (page.getByTestId('strip-text').element() as HTMLElement).click();
    await expect.element(strip).toHaveAttribute('data-expanded');

    await page.getByRole('button', { name: 'Switch' }).click();
    expect(onAct).toHaveBeenCalled();
    await expect.element(strip).toHaveAttribute('data-expanded');
  });

  test('an alert marked to stay in full is not folded to one line', async () => {
    renderWithProviders(
      <FooterStrips>
        <Alert data-testid="folded">A notice</Alert>
        <Alert data-testid="full" data-strip-full>
          Why Generate is off
        </Alert>
      </FooterStrips>
    );
    const clamp = async (id: string) => {
      const el = page.getByTestId(id);
      await expect.element(el).toBeInTheDocument();
      const message = el.element().querySelector('.mantine-Alert-message') as HTMLElement;
      return getComputedStyle(message).webkitLineClamp;
    };
    expect(await clamp('folded')).toBe('1');
    expect(await clamp('full')).not.toBe('1');
  });

  test('the footer keeps its height under a form that overflows', async () => {
    // The form scrolls in a fixed-height column with the footer last; its fields don't shrink.
    renderWithProviders(
      <div style={{ display: 'flex', flexDirection: 'column', height: 200, overflowY: 'auto' }}>
        <div style={{ height: 1000 }} />
        <div data-testid="footer" className={footerStripsFrame} style={{ padding: 8 }}>
          <FooterStrips>
            <Alert>A notice</Alert>
          </FooterStrips>
          <button>Generate</button>
        </div>
      </div>
    );
    const generate = page.getByRole('button', { name: 'Generate' });
    await expect.element(generate).toBeInTheDocument();
    const footer = page.getByTestId('footer').element().getBoundingClientRect();
    const button = generate.element().getBoundingClientRect();
    expect(button.bottom).toBeLessThanOrEqual(footer.bottom);
    expect(footer.height).toBeGreaterThan(button.height);
  });
});
