import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import { AppBuzzCapNoticeView } from '~/components/AppBlocks/AppBuzzCapNotice';
import type { MyAppBuzzCap } from '~/server/services/blocks/app-buzz-usage.service';

/**
 * The page host's paused-at-the-daily-cap notice. Props-only view; the query and the opt-in
 * mutation that feed it are the container's. The numbers are not today's 50,000 constant, so a
 * view printing a constant instead of the figures it was given fails.
 */

const NOW = Date.parse('2026-11-09T21:00:00Z');
const status = (over: Partial<MyAppBuzzCap> = {}): MyAppBuzzCap => ({
  used: 40_000,
  limit: 40_000,
  planLimit: 40_000,
  optInLimit: 65_000,
  optedIn: false,
  paused: true,
  canOptIn: true,
  resetAt: '2026-11-10T00:00:00.000Z',
  ...over,
});

async function renderBeside(data: MyAppBuzzCap | null | undefined, onOptIn = vi.fn()) {
  const { container } = await renderWithProviders(
    <>
      <div data-testid="render-barrier" />
      <AppBuzzCapNoticeView data={data} now={NOW} onOptIn={onOptIn} />
    </>
  );
  await expect.element(page.getByTestId('render-barrier')).toBeInTheDocument();
  return container;
}

const q = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('AppBuzzCapNoticeView', () => {
  // One render per test: the render barrier is found by test id, and two renders hold two.
  test('nothing while the viewer is under the cap', async () => {
    expect(q(await renderBeside(status({ paused: false })), 'app-buzz-cap-paused')).toBeNull();
  });

  test('nothing where the flag is off (the server answers null)', async () => {
    expect(q(await renderBeside(null), 'app-buzz-cap-paused')).toBeNull();
  });

  test('paused at the plan cap: the plan limit, the upgrade and raising the limit', async () => {
    const container = await renderBeside(status());
    const notice = q(container, 'app-buzz-cap-paused');
    expect(notice?.textContent).toContain("You've reached your plan's daily limit of 40,000 Buzz");
    // The copy says the limit rises; it never suggests a different payer.
    expect(notice?.textContent).toContain(
      'You can raise your limit to 65,000 for the rest of today. Apps keep spending your Buzz, as they do now'
    );
    expect(q(container, 'app-buzz-cap-opt-in')?.textContent).toBe(
      'Raise my limit to 65,000 for today'
    );
    expect(notice?.textContent).not.toContain('own Buzz');
    expect(q(container, 'app-buzz-cap-upgrade')?.getAttribute('href')).toBe('/pricing');
    expect(q(container, 'app-buzz-cap-opt-in')).not.toBeNull();
  });

  test('clicking continue asks for the opt-in', async () => {
    const onOptIn = vi.fn();
    await renderBeside(status(), onOptIn);
    await userEvent.click(page.getByTestId('app-buzz-cap-opt-in'));
    expect(onOptIn).toHaveBeenCalledTimes(1);
  });

  test('opt-in not offered (canOptIn false): the upgrade only', async () => {
    const container = await renderBeside(
      status({ limit: 50_000, planLimit: 50_000, optInLimit: 50_000, canOptIn: false })
    );
    expect(q(container, 'app-buzz-cap-upgrade')).not.toBeNull();
    expect(q(container, 'app-buzz-cap-opt-in')).toBeNull();
  });

  test('opted in and at the raised cap: it names the raised limit, no second opt-in', async () => {
    const container = await renderBeside(
      status({ optedIn: true, canOptIn: false, limit: 65_000, used: 65_000 })
    );
    expect(q(container, 'app-buzz-cap-paused')?.textContent).toContain(
      "You've reached today's limit of 65,000 Buzz"
    );
    expect(q(container, 'app-buzz-cap-opt-in')).toBeNull();
  });
});
