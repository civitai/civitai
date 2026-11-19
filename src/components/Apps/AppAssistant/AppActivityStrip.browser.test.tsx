import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { AppActivity } from '@civitai/app-assistant';
import { AppActivityStrip } from '~/components/Apps/AppAssistant/AppActivityStrip';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const ACTIVITY: AppActivity = {
  app: 'slideshow',
  summary:
    '1 generation: 1 succeeded (last 3 min ago); 0 failed; 0 in progress; 2 errors; 1 refused call',
  items: [
    {
      kind: 'error',
      at: ago(1),
      source: 'unhandledrejection',
      fatal: false,
      message: 'TypeError: next is not a function',
      stack: null,
    },
    {
      kind: 'call',
      at: ago(2),
      endpoint: '/api/v1/blocks/workflows/poll',
      scope: 'ai:write:budgeted',
      statusCode: 200,
      count: 3,
    },
    {
      kind: 'generation',
      at: ago(4),
      workflowId: 'wf-41',
      status: 'succeeded',
      completedAt: ago(3),
      imageCount: 2,
      cost: 12,
      error: null,
    },
    {
      kind: 'call',
      at: ago(5),
      endpoint: '/api/v1/blocks/workflows/submit',
      scope: 'ai:write:budgeted',
      statusCode: 403,
      count: 1,
    },
    {
      kind: 'error',
      at: ago(6),
      source: 'console',
      fatal: true,
      message: 'render died',
      stack: null,
    },
  ],
  omitted: 0,
  unavailable: [],
};

describe('AppActivityStrip', () => {
  test('shows the summary and the error count, and expands to the list in words', async () => {
    const fetchActivity = vi.fn(async () => ACTIVITY);
    renderWithProviders(
      <AppActivityStrip
        blockId="slideshow"
        onTellAssistant={() => undefined}
        fetchActivity={fetchActivity}
        now={() => NOW}
      />
    );
    await expect
      .element(page.getByTestId('app-activity-summary'))
      .toHaveTextContent(ACTIVITY.summary);
    await expect.element(page.getByTestId('app-activity-error-count')).toHaveTextContent('2');
    expect(fetchActivity).toHaveBeenCalledWith('slideshow');

    await page.getByRole('button', { name: /App activity/ }).click();
    const list = page.getByTestId('app-activity-list');
    await expect.element(list.getByText('App error')).toBeVisible();
    await expect.element(list.getByText('TypeError: next is not a function')).toBeVisible();
    // A call's label is `humaniseScopeInvocation`'s, with the count of a collapsed poll loop.
    await expect.element(list.getByText('Checked an AI workflow ×3')).toBeVisible();
    await expect.element(list.getByText('Generation succeeded')).toBeVisible();
    await expect.element(list.getByText('2 images · 12 Buzz')).toBeVisible();
    await expect.element(list.getByText('Refused (403)')).toBeVisible();
    await expect.element(list.getByText('App crashed')).toBeVisible();
    await expect.element(list.getByText('1 min ago')).toBeVisible();
  });

  test('Tell the assistant hands the message to compose once, as text the user can edit', async () => {
    const onTellAssistant = vi.fn();
    renderWithProviders(
      <AppActivityStrip
        blockId="slideshow"
        onTellAssistant={onTellAssistant}
        fetchActivity={async () => ACTIVITY}
        now={() => NOW}
      />
    );
    await expect
      .element(page.getByTestId('app-activity-summary'))
      .toHaveTextContent(ACTIVITY.summary);
    await page.getByRole('button', { name: 'Tell the assistant' }).click();
    expect(onTellAssistant).toHaveBeenCalledTimes(1);
    const text = onTellAssistant.mock.calls[0]![0] as string;
    expect(text.split('\n').slice(0, 4)).toEqual([
      'The preview of my app seems stuck or wrong. Here is what it did recently; please look at this before guessing what is wrong:',
      '',
      'App activity of slideshow in the last 2 hours, newest first:',
      ACTIVITY.summary,
    ]);
    expect(text).toContain(
      '- 1 min ago · error (unhandledrejection) · "TypeError: next is not a function"'
    );
  });

  test('reads nothing while it is not on screen, and polls while it is (the control)', async () => {
    const hidden = vi.fn(async () => ACTIVITY);
    const shown = vi.fn(async () => ACTIVITY);
    renderWithProviders(
      <div>
        <div style={{ display: 'none' }}>
          <AppActivityStrip
            blockId="hidden-app"
            onTellAssistant={() => undefined}
            fetchActivity={hidden}
            pollMs={40}
          />
        </div>
        <AppActivityStrip
          blockId="shown-app"
          onTellAssistant={() => undefined}
          fetchActivity={shown}
          pollMs={40}
        />
      </div>
    );
    await vi.waitFor(() => expect(shown.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(hidden).not.toHaveBeenCalled();
  });

  test('says so when the activity cannot be read, and offers nothing to tell', async () => {
    renderWithProviders(
      <AppActivityStrip
        blockId="slideshow"
        onTellAssistant={() => undefined}
        fetchActivity={async () => {
          throw new Error('unavailable');
        }}
      />
    );
    await expect
      .element(page.getByTestId('app-activity-summary'))
      .toHaveTextContent('Activity could not be read just now');
    await expect.element(page.getByRole('button', { name: 'Tell the assistant' })).toBeDisabled();
  });
});
