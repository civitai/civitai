import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@mantine/core/styles.css';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { ServiceOfferingMenu } from './ServiceOfferingMenu';

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  openReportModal: vi.fn(),
  notifyError: vi.fn(),
  getMine: vi.fn(),
  getSellEligibility: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'creatorService.remove': { useMutation: () => ({ mutate: mocks.remove }) },
      'creatorService.setStatus': { useMutation: () => ({ mutate: vi.fn() }) },
      'creatorService.upsert': { useMutation: () => ({ mutate: vi.fn() }) },
      'creatorService.takedown': { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    {
      useUtils: () => ({
        creatorService: {
          getMine: { fetch: mocks.getMine },
          getSellEligibility: { fetch: mocks.getSellEligibility },
        },
      }),
    }
  ),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: mocks.notifyError,
}));
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: mocks.openReportModal }));
// LoginRedirect and requireLogin are the real ones; only the session flag, the router and the tour
// context, the boundaries they read, are stood in for, and the login popup is a window.open spy.
vi.mock('~/components/Tours/ToursProvider', () => ({
  useTourContext: () => ({ running: false, pauseTour: vi.fn(), activeTour: null }),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: '/services/42' }) }));

const openWindow = vi.spyOn(window, 'open').mockReturnValue({ closed: true } as Window);

const offering = { id: 42, title: 'Portrait commission' };
const open = async (props: {
  isOwner: boolean;
  isModerator: boolean;
  placement?: 'card' | 'title';
}) => {
  renderWithProviders(
    <>
      <ServiceOfferingMenu offering={offering} {...props} />
      <DialogProvider />
    </>
  );
  await page.getByLabelText('Service options').click();
};
const item = (name: string) => page.getByRole('menuitem', { name });

describe('ServiceOfferingMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.isAuthed = true;
    openWindow.mockClear();
  });
  afterEach(() => {
    // Only the trigger spies a test installs: the module-scope window.open spy stays.
    if (vi.isMockFunction(dialogStore.trigger)) vi.mocked(dialogStore.trigger).mockRestore();
    dialogStore.closeAll();
  });

  test('a visitor can report and not delete', async () => {
    await open({ isOwner: false, isModerator: false });
    await expect.element(item('Report this service')).toBeVisible();
    expect(document.body.textContent).not.toContain('Delete');
    expect(document.body.textContent).not.toContain('Duplicate');
    await item('Report this service').click();
    expect(mocks.openReportModal).toHaveBeenCalledTimes(1);
    expect(mocks.openReportModal).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: ReportEntity.ServiceOffering, entityId: 42 })
    );
  });

  test('a signed-out visitor sees Report too, and clicking it opens the login popup, not the report', async () => {
    window.isAuthed = false;
    await open({ isOwner: false, isModerator: false });
    await expect.element(item('Report this service')).toBeVisible();
    await item('Report this service').click();
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(mocks.openReportModal).not.toHaveBeenCalled();
  });

  test('the title-row placement offers the same Report to a visitor', async () => {
    await open({ isOwner: false, isModerator: false, placement: 'title' });
    await expect.element(item('Report this service')).toBeVisible();
    await item('Report this service').click();
    expect(mocks.openReportModal).toHaveBeenCalledTimes(1);
  });

  test('the seller deletes their own service after confirming, and cannot report it', async () => {
    await open({ isOwner: true, isModerator: false });
    expect(document.body.textContent).not.toContain('Report this service');
    await item('Delete').click();
    await expect.element(page.getByText(/leaves your shop for good/)).toBeVisible();
    expect(mocks.remove).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Remove' }).click();
    expect(mocks.remove).toHaveBeenCalledWith({ id: 42 });
  });

  test('a moderator can report, and takes the service down only with a reason', async () => {
    await open({ isOwner: false, isModerator: true });
    await expect.element(item('Report this service')).toBeVisible();
    expect(document.body.textContent).not.toContain('Duplicate');
    await item('Delete').click();
    await expect.element(page.getByText('Take down service')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Yes, take it down' })).toBeDisabled();
  });

  test("the seller's Duplicate opens the form from their full row, not the card's partial one", async () => {
    const fullRow = { ...offering, description: 'Full text.', price: 2500, maxOpenDeals: 4 };
    mocks.getMine.mockResolvedValue({ items: [fullRow], hiddenOffDomain: 0 });
    mocks.getSellEligibility.mockResolvedValue({ canSell: true });
    // Recorded, not opened: the form modal is not what this test is about.
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined);
    await open({ isOwner: true, isModerator: false });
    await item('Duplicate').click();
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
    expect(trigger.mock.calls[0][0].props).toEqual({ copyOf: fullRow });
  });

  test('a seller who cannot sell is told why, and gets no form', async () => {
    mocks.getMine.mockResolvedValue({ items: [offering], hiddenOffDomain: 0 });
    mocks.getSellEligibility.mockResolvedValue({ canSell: false });
    const trigger = vi.spyOn(dialogStore, 'trigger');
    await open({ isOwner: true, isModerator: false });
    await item('Duplicate').click();
    await vi.waitFor(() => expect(mocks.notifyError).toHaveBeenCalledTimes(1));
    expect(trigger).not.toHaveBeenCalled();
  });
});
