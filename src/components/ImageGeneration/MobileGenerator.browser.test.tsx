import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { MobileGenerator } from '~/components/ImageGeneration/MobileGenerator';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import { resetHistoryLayers } from '~/utils/history-layers';

// The results and their actions are their own components with their own data; stand-ins mark
// which density is showing.
vi.mock('~/components/ImageGeneration/GenerationResults', () => ({
  GenerationResults: ({ view }: { view: string }) => <div data-testid="results">{view}</div>,
}));
vi.mock('~/components/ImageGeneration/GeneratedImageActions', () => ({
  GeneratedImageActions: () => null,
}));
vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationStatus: () => ({ limits: { queue: 4 } }),
}));
vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', () => ({
  useGetTextToImageRequests: () => ({ data: [] }),
}));
vi.mock('~/components/Challenges/challenge.utils', () => ({
  useGetActiveChallenges: () => ({ challenges: [], loading: false }),
  dismissChallenges: vi.fn(),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({}),
  useOptionalFeatureFlags: () => ({ mobileGenerator: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const view = () => useGenerationPanelStore.getState().view;

function renderGenerator() {
  renderWithProviders(
    <MobileGenerator form={<p>The form</p>} onClose={vi.fn()} closeLabel="Go back" />
  );
}

describe('MobileGenerator', () => {
  beforeEach(async () => {
    // A sheet left open by the last test goes back over its entry once unmounted; let it land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    resetHistoryLayers();
    localStorage.clear();
    useGenerationPanelStore.setState({ view: 'generate' });
    useMobileGeneratorStore.setState({ submittedAt: 0 });
  });

  test("the panel's 'generate' view is the open sheet, and its chevron returns to the results", async () => {
    useGenerationPanelStore.setState({ view: 'feed' });
    renderGenerator();
    await page.getByRole('button', { name: 'Open the form' }).click();
    expect(view()).toBe('generate');

    await page.getByRole('button', { name: 'Close the form' }).click();
    // Back to the density that was showing, not to a default.
    expect(view()).toBe('feed');
  });

  test('dragging the closed bar up opens the form', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const barLocator = page.getByRole('button', { name: 'Open the form' });
    await expect.element(barLocator).toBeInTheDocument();
    const bar = barLocator.element();
    const { x, y } = bar.getBoundingClientRect();
    const pointer = (type: string, clientY: number) =>
      bar.dispatchEvent(
        new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x + 20, clientY })
      );
    pointer('pointerdown', y + 20);
    pointer('pointermove', y - 20);
    pointer('pointerup', y - 40);

    expect(view()).toBe('generate');
  });

  test('tapping the dimmed screen above the open sheet closes it', async () => {
    renderGenerator();
    await expect.element(page.getByRole('button', { name: 'Close the form' })).toBeInTheDocument();
    // Closing goes back over the sheet's history entry; let that land before the next test.
    const popped = new Promise((resolve) => addEventListener('popstate', resolve, { once: true }));
    // The strip has no role: it is the screen behind the sheet, not a control of its own.
    (document.querySelector('[data-visible]') as HTMLElement).click();
    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    await popped;
  });

  test('Back closes the open sheet and keeps the generator', async () => {
    // An entry of the test page's own under the layer: without the layer, Back fails the test here
    // instead of leaving the page.
    history.pushState(history.state, '');
    renderGenerator();
    await expect.element(page.getByRole('button', { name: 'Close the form' })).toBeInTheDocument();
    history.back();
    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    expect(view()).toBe('queue');
  });

  test('the density toggle switches the results between batches and grid', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    await page.getByRole('button', { name: 'Grid' }).click();

    expect(view()).toBe('feed');
    await expect.element(page.getByTestId('results')).toHaveTextContent('feed');
    await expect
      .element(page.getByRole('button', { name: 'Grid' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('a submitted generation closes the sheet onto the results', async () => {
    renderGenerator();
    await expect.element(page.getByRole('button', { name: 'Close the form' })).toBeInTheDocument();
    useMobileGeneratorStore.setState({ submittedAt: Date.now() });

    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    expect(view()).toBe('queue');
  });

  test('the open-the-form hint shows once the sheet is closed, until it is opened from the bar', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const hint = page.getByText('Pull up or tap to open the form');
    await expect.element(hint).toBeInTheDocument();

    await page.getByRole('button', { name: 'Open the form' }).click();
    await page.getByRole('button', { name: 'Close the form' }).click();
    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    await expect.element(hint).not.toBeInTheDocument();
  });

  test('the closed sheet keeps the form mounted but out of reach', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const form = page.getByText('The form', { exact: true });
    await expect.element(form).toBeInTheDocument();
    expect(form.element().closest('[inert]')).not.toBeNull();
  });
});
