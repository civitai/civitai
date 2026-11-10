import type * as VisualViewportModule from '~/hooks/useVisualViewportBottomInset';
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
import { historyLayersSettled, resetHistoryLayers } from '~/utils/history-layers';
import { TitleRowReset } from '~/components/form-graph/generation/MobileFooterParts';

// The results and their actions are their own components with their own data; stand-ins mark
// which density is showing.
// The stand-in scrolls, as the real results do.
vi.mock('~/components/ImageGeneration/GenerationResults', () => ({
  GenerationResults: ({ view, className }: { view: string; className?: string }) => (
    <div data-testid="results" className={className} style={{ height: 300, overflowY: 'auto' }}>
      {view}
      <div style={{ height: 3000 }} />
    </div>
  ),
}));
vi.mock('~/components/ImageGeneration/GeneratedImageActions', () => ({
  GeneratedImageActions: () => <span>Image actions</span>,
}));
// The test browser has no on-screen keyboard; whether one is up is this flag.
let keyboardOpen = false;
vi.mock('~/hooks/useVisualViewportBottomInset', async (orig) => ({
  ...(await orig<typeof VisualViewportModule>()),
  useKeyboardOpen: () => keyboardOpen,
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
  GENERATOR_QUEUE_INPUT: { excludeAppWorkflows: true },
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

describe('MobileGenerator', () => {
  beforeEach(async () => {
    // A sheet left open by the last test goes back over its entry once unmounted; let it land.
    await historyLayersSettled();
    resetHistoryLayers();
    keyboardOpen = false;
    localStorage.clear();
    useGenerationPanelStore.setState({ view: 'generate' });
    queueLimit = 4;
    tier = 'gold';
    requests = [];
  });

  test("the panel's 'generate' view is the open sheet, and its chevron returns to the results", async () => {
    useGenerationPanelStore.setState({ view: 'feed' });
    renderGenerator();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    expect(view()).toBe('generate');
    await expect
      .element(page.getByRole('button', { name: 'Create', exact: true }))
      .not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Close the form' }).click();
    // Back to the density that was showing, not to a default.
    expect(view()).toBe('feed');
  });

  test('Back closes the open sheet and keeps the generator', async () => {
    // An entry of the test page's own under the layer: without the layer, Back fails the test here
    // instead of leaving the page.
    history.pushState(history.state, '');
    renderGenerator();
    await expect.element(page.getByRole('button', { name: 'Close the form' })).toBeInTheDocument();
    history.back();
    await expect
      .element(page.getByRole('button', { name: 'Create', exact: true }))
      .toBeInTheDocument();
    expect(view()).toBe('queue');
  });

  test('dragging the open form down by its title row closes it', async () => {
    useGenerationPanelStore.setState({ view: 'generate' });
    renderGenerator();
    const close = page.getByRole('button', { name: 'Close the form' });
    await expect.element(close).toBeInTheDocument();
    const head = close.element().closest('section')!.firstElementChild as HTMLElement;
    const pointer = (type: string, clientY: number) =>
      head.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, clientY }));
    pointer('pointerdown', 20);
    pointer('pointermove', 100);
    pointer('pointerup', 100);

    expect(view()).not.toBe('generate');
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

  test('the header slides away while the results scroll down, and comes back on the way up', async () => {
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
    const resultsBox = () => {
      const { top, height } = results.element().parentElement!.getBoundingClientRect();
      return { top, height };
    };
    const before = resultsBox();
    // The results start clear of the header lying over them.
    expect(parseFloat(getComputedStyle(results.element()).paddingTop)).toBeCloseTo(
      header.element().getBoundingClientRect().height,
      1
    );

    scrollTo(400);
    await expect.element(header).toHaveAttribute('data-hidden');
    // Once it has slid off the results, they have kept their place and size.
    await expect
      .poll(() => header.element().getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(before.top);
    expect(resultsBox()).toEqual(before);
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

  test('the closed sheet keeps the form mounted but out of reach', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderGenerator();
    const form = page.getByText('The form', { exact: true });
    await expect.element(form).toBeInTheDocument();
    expect(form.element().closest('[inert]')).not.toBeNull();
  });

  test("the form's Reset sits in the open sheet's title row", async () => {
    renderWithProviders(
      <MobileGenerator
        form={<TitleRowReset onReset={vi.fn()} />}
        onClose={vi.fn()}
        closeLabel="Go back"
      />
    );
    const reset = page.getByRole('button', { name: 'Reset', exact: true });
    await expect.element(reset).toBeInTheDocument();
    // In the title row, beside the chevron, not down in the form.
    const chevron = page.getByRole('button', { name: 'Close the form' }).element();
    expect(chevron.parentElement?.contains(reset.element())).toBe(true);
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

  test("while jobs run, the open form's chevron spins and counts them", async () => {
    const running = (id: string) => ({
      id,
      status: 'processing',
      steps: [{ params: { quantity: 2 }, output: [] }],
      completedCount: 0,
      processingCount: 2,
    });
    requests = [running('a'), running('b')];
    renderGenerator();

    const chevron = page.getByRole('button', { name: 'Close the form, 2 generating' });
    await expect.element(chevron).toHaveAttribute('data-running');
    await expect.element(chevron).toHaveTextContent('2');
  });

  test('with nothing running the chevron is plain', async () => {
    renderGenerator();

    const chevron = page.getByRole('button', { name: 'Close the form', exact: true });
    await expect.element(chevron).toBeInTheDocument();
    expect(chevron.element().hasAttribute('data-running')).toBe(false);
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

  test('closed, the form is a Create button, and its own actions wait for the open sheet', async () => {
    useGenerationPanelStore.setState({ view: 'queue' });
    renderWithProviders(
      <MobileGenerator
        form={<TitleRowReset onReset={vi.fn()} />}
        onClose={vi.fn()}
        closeLabel="Go back"
      />
    );
    const create = page.getByRole('button', { name: 'Create', exact: true });
    await expect.element(create).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Presets' })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Reset', exact: true }))
      .not.toBeInTheDocument();

    await create.click();
    await expect.element(page.getByRole('button', { name: 'Presets' })).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Reset', exact: true }))
      .toBeInTheDocument();
  });

  test('while a field is typed in with the keyboard up, the footer steps aside for it', async () => {
    keyboardOpen = true;
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

  test('the footer waits for the tap that left the field before coming back', async () => {
    keyboardOpen = true;
    renderWithProviders(
      <MobileGenerator
        form={
          <>
            <textarea aria-label="Prompt" />
            <button type="button">Seed</button>
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

    // A tap blurs the field on its mousedown; a footer back by then would take the tap's click.
    (page.getByRole('button', { name: 'Seed' }).element() as HTMLElement).focus();
    // Well after a footer with no wait would be back, and well before the wait ends.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getComputedStyle(footer.element()).display).toBe('none');
    await expect.element(footer).toBeVisible();
  });

  test('a focused field with the keyboard down (dismissed, or a hardware one) keeps the footer', async () => {
    keyboardOpen = false;
    renderWithProviders(
      <MobileGenerator
        form={
          <>
            <textarea aria-label="Prompt" />
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
    await expect.element(page.getByRole('textbox', { name: 'Prompt' })).toHaveFocus();
    await expect.element(footer).toBeVisible();
  });
});
