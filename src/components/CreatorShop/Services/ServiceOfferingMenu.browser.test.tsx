import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ModalsProvider } from '@mantine/modals';
import { page } from 'vitest/browser';
import '@mantine/core/styles.css';
import { ReportEntity } from '~/shared/utils/report-helpers';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { ServiceOfferingMenu } from './ServiceOfferingMenu';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), openReportModal: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'creatorService.remove': { useMutation: () => ({ mutate: mocks.remove }) },
    'creatorService.setStatus': { useMutation: () => ({ mutate: vi.fn() }) },
    'creatorService.upsert': { useMutation: () => ({ mutate: vi.fn() }) },
    'creatorService.takedown': { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  }),
}));
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: mocks.openReportModal }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));

const offering = { id: 42, title: 'Portrait commission' };
const open = async (props: { isOwner: boolean; isModerator: boolean }) => {
  renderWithProviders(
    <ModalsProvider>
      <ServiceOfferingMenu offering={offering} {...props} />
    </ModalsProvider>
  );
  await page.getByLabelText('Service options').click();
};
const item = (name: string) => page.getByRole('menuitem', { name });

describe('ServiceOfferingMenu', () => {
  beforeEach(() => vi.clearAllMocks());

  test('a visitor can report and not delete', async () => {
    await open({ isOwner: false, isModerator: false });
    await expect.element(item('Report this service')).toBeVisible();
    expect(document.body.textContent).not.toContain('Delete');
    await item('Report this service').click();
    expect(mocks.openReportModal).toHaveBeenCalledTimes(1);
    expect(mocks.openReportModal).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: ReportEntity.ServiceOffering, entityId: 42 })
    );
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
    await item('Delete').click();
    await expect.element(page.getByText('Take down service')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Yes, take it down' })).toBeDisabled();
  });
});
