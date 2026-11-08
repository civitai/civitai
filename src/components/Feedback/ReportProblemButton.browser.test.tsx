import { Notifications, notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * "Report this" on error toasts, through the real `showErrorNotification` and the real Mantine
 * `<Notifications />`. Faked: `trpc` (no transport in the scaffold; `getArea` answers per area from
 * `mocks.enabled`) and `dialogStore` (to read what the drawer would be opened with).
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    trigger: vi.fn(),
    enabled: {} as Record<string, boolean>,
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: makeTrpcProxy({
      'feedback.getArea': {
        useQuery: ({ area }: { area: string }, opts?: { enabled?: boolean }) => ({
          data: opts?.enabled === false ? undefined : { enabled: !!mocks.enabled[area] },
        }),
      },
    }),
  };
});

vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: mocks.trigger },
}));

const SERVER_FAULT = 'An unexpected error occurred (ref: 0123456789ab)';
const reportButton = () => page.getByRole('button', { name: 'Report this' });
/** The "Report this" button inside the toast showing `text`, or null. */
function actionIn(text: string) {
  const toast = page.getByText(text).element().closest('.mantine-Notification-root');
  expect(toast, 'the toast root class changed; this check would see nothing').not.toBeNull();
  return (
    Array.from(toast?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Report this'
    ) ?? null
  );
}
type Opened = { props: { area: string; context: Record<string, unknown> } };
const opened = () => mocks.trigger.mock.calls.at(-1)?.[0] as Opened;

describe('showErrorNotification — Report this', () => {
  beforeEach(() => {
    mocks.trigger.mockReset();
    mocks.enabled = { 'site-bug-report': true, orchestration: true };
    renderWithProviders(<Notifications />);
  });
  afterEach(() => notifications.clean());

  test('a masked server fault offers it, and files its ref and the text shown', async () => {
    showErrorNotification({ title: 'Could not save', error: new Error(SERVER_FAULT) });
    await userEvent.click(reportButton());

    expect(opened().props.area).toBe('site-bug-report');
    expect(opened().props.context).toMatchObject({
      errorRef: '0123456789ab',
      toast: { title: 'Could not save', message: SERVER_FAULT },
    });
    // The drawer replaces the toast; a wrong id in `onOpen` would leave it up behind the drawer.
    await expect.element(page.getByText('Could not save')).not.toBeInTheDocument();
  });

  // Validation toasts stay buttonless: a report about "too small" helps nobody. The server-fault
  // toast in the same render is the control that proves the button would have had time to appear.
  test('a plain validation message offers nothing', async () => {
    showErrorNotification({ error: new Error('Images must be at least 256x256px.') });
    showErrorNotification({ error: new Error(SERVER_FAULT) });

    await expect.element(reportButton()).toBeInTheDocument();
    expect(actionIn('Images must be at least 256x256px.')).toBeNull();
  });

  test('an orchestration caller routes to its area with the ids it holds', async () => {
    showErrorNotification({
      error: new Error('Failed to auto tag'),
      report: { area: 'orchestration', workflowId: '20-20261102000000000000', jobId: 'bad id!' },
    });
    await userEvent.click(reportButton());

    expect(opened().props.area).toBe('orchestration');
    expect(opened().props.context.workflowId).toBe('20-20261102000000000000');
    // A malformed id would fail the whole submission at the schema, so it is dropped.
    expect(opened().props.context).not.toHaveProperty('jobId');
  });

  test('with the orchestration area off, it still files — as a site bug, ids kept', async () => {
    mocks.enabled.orchestration = false;
    showErrorNotification({
      error: new Error('Failed to auto tag'),
      report: { area: 'orchestration', workflowId: '20-1' },
    });
    await userEvent.click(reportButton());

    expect(opened().props.area).toBe('site-bug-report');
    expect(opened().props.context.workflowId).toBe('20-1');
  });

  test('with no area collecting, there is no button to dead-end on', async () => {
    // Control: the same toast with an area on shows the button, which also settles the lazy
    // import, so the absence below is the area check and not a button still loading.
    showErrorNotification({ title: 'Working', error: new Error(SERVER_FAULT) });
    await expect.element(reportButton()).toBeInTheDocument();
    mocks.enabled = {};
    showErrorNotification({ title: 'Broken', error: new Error(SERVER_FAULT) });

    await expect.element(page.getByText('Broken')).toBeInTheDocument();
    // Scoped to its own toast: the control above may still be animating out.
    expect(actionIn('Broken')).toBeNull();
  });
});
