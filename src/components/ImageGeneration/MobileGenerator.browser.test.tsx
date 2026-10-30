import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import {
  GenerationProvider,
  useGenerationContextStore,
} from '~/components/ImageGeneration/GenerationProvider';
import { MobileGenerator } from '~/components/ImageGeneration/MobileGenerator';
import { QueueLimitBanner } from '~/components/ImageGeneration/QueueSnackbar';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import { historyLayersSettled, resetHistoryLayers } from '~/utils/history-layers';
import { TitleRowReset } from '~/components/form-graph/generation/MobileFooterParts';

// The results and their actions are their own components with their own data; stand-ins mark
// which density is showing.
// The stand-in scrolls, as the real results do.
vi.mock('~/components/ImageGeneration/GenerationResults', () => ({
  GenerationResults: ({ view }: { view: string }) => (
    <div data-testid="results" style={{ height: 300, overflowY: 'auto' }}>
      {view}
      <div style={{ height: 3000 }} />
    </div>
  ),
}));
vi.mock('~/components/ImageGeneration/GeneratedImageActions', () => ({
  GeneratedImageActions: () => <span>Image actions</span>,
}));
let selectedCount = 0;
vi.mock('~/components/ImageGeneration/utils/generationImage.select', () => ({
  useSelectedCount: () => selectedCount,
}));
// The queue: the member's slot limit and the requests in flight.
let queueLimit = 4;
let tier = 'gold';
let requests: unknown[] = [];
vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationStatus: () => ({ limits: { queue: queueLimit }, available: true, tier }),
}));
vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', () => ({
  useGetTextToImageRequests: () => ({ data: requests, isLoading: false }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ challengePlatform: true, generationPresets: true }),
  useOptionalFeatureFlags: () => ({ mobileGenerator: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// The challenges and presets buttons are their own components with their own data; stand-ins
// mark where they sit.
vi.mock('~/components/Challenges/ChallengeIndicator', () => ({
  ChallengeIndicator: () => <button>Daily challenges</button>,
}));
vi.mock('~/components/generation_v2/preset/PresetHeaderButton', () => ({
  PresetHeaderButton: () => <button>Presets</button>,
}));

const view = () => useGenerationPanelStore.getState().view;

function renderGenerator() {
  renderWithProviders(
    <MobileGenerator form={<p>The form</p>} onClose={vi.fn()} closeLabel="Go back" />
  );
}

const COACH_KEY = 'mobile-generator-sheet-hint';

describe('MobileGenerator', () => {
  beforeEach(async () => {
    // A sheet left open by the last test goes back over its entry once unmounted; let it land.
    await historyLayersSettled();
    resetHistoryLayers();
    localStorage.clear();
    // The first-run swipe coach covers the screen; its own tests clear this.
    localStorage.setItem(COACH_KEY, JSON.stringify('done'));
    useGenerationPanelStore.setState({ view: 'generate' });
    useMobileGeneratorStore.setState({ submittedAt: 0 });
    queueLimit = 4;
    tier = 'gold';
    requests = [];
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
    await page.getByRole('button', { name: 'Show as grid' }).click();

    expect(view()).toBe('feed');
    await expect.element(page.getByTestId('results')).toHaveTextContent('feed');
    await page.getByRole('button', { name: 'Show as batches' }).click();
    expect(view()).toBe('queue');
  });

  test('the header folds away while the results scroll down, and comes back on the way up', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const results = page.getByTestId('results');
    await expect.element(results).toBeInTheDocument();
    const header = page.getByRole('banner');
    const scrollTo = (top: number) => {
      const el = results.element() as HTMLElement;
      el.scrollTop = top;
      el.dispatchEvent(new Event('scroll'));
    };

    scrollTo(400);
    await expect.element(header).toHaveAttribute('data-hidden');
    scrollTo(250);
    await expect.element(header).not.toHaveAttribute('data-hidden');
    scrollTo(800);
    await expect.element(header).toHaveAttribute('data-hidden');
    // Back near the top it shows, whichever way the last scroll went.
    scrollTo(20);
    await expect.element(header).not.toHaveAttribute('data-hidden');
  });

  test('while images are selected, the header is their actions and stays put', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    selectedCount = 2;
    try {
      renderGenerator();
      await expect.element(page.getByText('Image actions')).toBeInTheDocument();
      await expect.element(page.getByText('Generator', { exact: true })).not.toBeInTheDocument();
      const results = page.getByTestId('results').element() as HTMLElement;
      results.scrollTop = 400;
      results.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(page.getByRole('banner').element().hasAttribute('data-hidden')).toBe(false);
    } finally {
      selectedCount = 0;
    }
  });

  test('a submitted generation closes the sheet onto the results', async () => {
    renderGenerator();
    await expect.element(page.getByRole('button', { name: 'Close the form' })).toBeInTheDocument();
    useMobileGeneratorStore.setState({ submittedAt: Date.now() });

    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    expect(view()).toBe('queue');
  });

  test('the first closed sheet is held behind the swipe coach until a swipe up opens the form', async () => {
    localStorage.removeItem(COACH_KEY);
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const text = page.getByText('Swipe up to open the form');
    await expect.element(text).toBeVisible();
    const coach = text.element().parentElement as HTMLElement;

    // It covers the results, so a tap there lands on the coach, and a tap opens nothing.
    const results = page.getByTestId('results').element().getBoundingClientRect();
    const hit = document.elementFromPoint(results.x + 20, results.y + 20);
    expect(coach.contains(hit)).toBe(true);
    const pointer = (type: string, clientY: number) =>
      coach.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, clientY }));
    pointer('pointerdown', 300);
    pointer('pointerup', 300);
    expect(view()).toBe('queue');

    pointer('pointerdown', 300);
    pointer('pointermove', 260);
    pointer('pointerup', 240);
    expect(view()).toBe('generate');

    await page.getByRole('button', { name: 'Close the form' }).click();
    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    await expect.element(text).not.toBeInTheDocument();
  });

  test('a form first opened another way (Remix) leaves no coach behind when it closes', async () => {
    localStorage.removeItem(COACH_KEY);
    renderGenerator();
    await page.getByRole('button', { name: 'Close the form' }).click();
    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    await expect.element(page.getByText('Swipe up to open the form')).not.toBeInTheDocument();
  });

  test('tapping the bar also completes the swipe coach', async () => {
    localStorage.removeItem(COACH_KEY);
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const text = page.getByText('Swipe up to open the form');
    await expect.element(text).toBeVisible();

    await page.getByRole('button', { name: 'Open the form' }).click();
    await page.getByRole('button', { name: 'Close the form' }).click();
    await expect.element(page.getByRole('button', { name: 'Open the form' })).toBeInTheDocument();
    await expect.element(text).not.toBeInTheDocument();
  });

  test('the closed sheet keeps the form mounted but out of reach', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const form = page.getByText('The form', { exact: true });
    await expect.element(form).toBeInTheDocument();
    expect(form.element().closest('[inert]')).not.toBeNull();
  });

  test("the form's Reset sits in the open sheet's title row", async () => {
    const onReset = vi.fn();
    renderWithProviders(
      <MobileGenerator
        form={<TitleRowReset onReset={onReset} />}
        onClose={vi.fn()}
        closeLabel="Go back"
      />
    );
    const reset = page.getByRole('button', { name: 'Reset', exact: true });
    await expect.element(reset).toBeInTheDocument();
    // In the title row, beside the chevron, not down in the form.
    const chevron = page.getByRole('button', { name: 'Close the form' }).element();
    expect(chevron.parentElement?.contains(reset.element())).toBe(true);
    await reset.click();
    expect(onReset).toHaveBeenCalled();
  });

  test('the header shows every queue slot on one line, with the jobs in flight', async () => {
    queueLimit = 12;
    const running = (id: string) => ({
      id,
      status: 'processing',
      steps: [{ params: { quantity: 2 }, output: [] }],
      completedCount: 1,
      processingCount: 1,
    });
    requests = [running('a'), running('b')];
    renderGenerator();

    await expect.element(page.getByLabelText('Jobs in the queue')).toHaveTextContent('2/12');
    const header = page.getByRole('banner').element();
    await vi.waitFor(() => expect(header.querySelectorAll('[data-slot]')).toHaveLength(12));
    expect(header.querySelectorAll('[data-slot="processing"]')).toHaveLength(2);
  });

  test("the form's queue state is the header's, not a second copy", async () => {
    // The form brings its own GenerationProvider; inside the mobile generator's it must defer.
    const stores = new Set<unknown>();
    function Probe() {
      stores.add(useGenerationContextStore());
      return <p>Probed</p>;
    }
    renderWithProviders(
      <GenerationProvider>
        <Probe />
        <GenerationProvider>
          <Probe />
        </GenerationProvider>
      </GenerationProvider>
    );
    await expect.element(page.getByText('Probed').first()).toBeInTheDocument();
    expect(stores.size).toBe(1);
  });

  test("a free member's full queue says so, with the way to a bigger one", async () => {
    tier = 'free';
    queueLimit = 1;
    requests = [
      { id: 'a', status: 'processing', steps: [], completedCount: 0, processingCount: 1 },
    ];
    renderWithProviders(
      <GenerationProvider>
        <QueueLimitBanner />
      </GenerationProvider>
    );
    await expect.element(page.getByText('You can queue 1 jobs at once')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'Increase' })).toBeInTheDocument();
  });

  test("the closed form's bar is its title row, without the form's own actions", async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderWithProviders(
      <MobileGenerator
        form={<TitleRowReset onReset={vi.fn()} />}
        onClose={vi.fn()}
        closeLabel="Go back"
      />
    );
    const bar = page.getByRole('button', { name: 'Open the form' });
    await expect.element(bar).toHaveTextContent('Generate');
    await expect.element(page.getByRole('button', { name: 'Presets' })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Reset', exact: true }))
      .not.toBeInTheDocument();

    await bar.click();
    await expect.element(page.getByRole('button', { name: 'Presets' })).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Reset', exact: true }))
      .toBeInTheDocument();
  });

  test('while a field is typed in, the footer steps aside for the keyboard', async () => {
    renderWithProviders(
      <MobileGenerator
        form={
          <>
            <textarea aria-label="Prompt" />
            <input type="checkbox" aria-label="Raw mode" />
            <div data-generator-footer style={{ display: 'flex' }}>
              Generate row
            </div>
          </>
        }
        onClose={vi.fn()}
        closeLabel="Go back"
      />
    );
    const footer = page.getByText('Generate row');
    await expect.element(footer).toBeVisible();

    (page.getByRole('textbox', { name: 'Prompt' }).element() as HTMLElement).focus();
    await expect.element(footer).not.toBeVisible();

    // A control that brings up no keyboard leaves the footer where it is.
    (page.getByRole('checkbox', { name: 'Raw mode' }).element() as HTMLElement).focus();
    await expect.element(footer).toBeVisible();
  });
});
