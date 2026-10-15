import { createElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';

// Users had no way to report an offering. The server takes offering reports (moderator queue);
// these pin that the storefront and the deal page offer the report, to the right people.

const mocks = vi.hoisted(() => ({
  openReportModal: vi.fn(),
  viewerId: 1 as number | null,
}));

vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: mocks.openReportModal }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.viewerId == null ? null : { id: mocks.viewerId }),
}));
vi.mock('~/components/CreatorShop/Services/creator-service.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryShopServices: () => ({
    offerings: [
      {
        id: 42,
        title: 'Portrait commission',
        description: 'One portrait.',
        price: 500,
        deliveryDays: 5,
        revisionsIncluded: 1,
        maxNsfwLevel: 2,
        slotsOpen: null,
      },
    ],
    isLoading: false,
  }),
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceRequestModal', () => ({
  ServiceRequestModal: () => null,
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: () => undefined } }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));

const { reportKeysFor } = await import('~/components/Modals/ReportModal');
const { ReportServiceButton } = await import(
  '~/components/CreatorShop/Services/ReportServiceButton'
);
const { ServicesSection } = await import('~/components/CreatorShop/Storefront/ServicesSection');

const SELLER = 9;
const renderShop = () =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServicesSection, { ownerUserId: SELLER, username: 'seller' })
    )
  );
const REPORT = />Report<\/span>/;

beforeEach(() => {
  mocks.openReportModal.mockClear();
  mocks.viewerId = 1;
});

describe('reporting a service', () => {
  it('offers exactly the reasons the moderator queue takes for a service', () => {
    expect(reportKeysFor(ReportEntity.ServiceOffering)).toEqual([
      'nsfw-article',
      'tos',
      'admin-attention',
      'spam',
    ]);
  });

  it('opens the report modal on that offering', () => {
    // LoginRedirect is a passthrough here: the element tree is <LoginRedirect><Button/></LoginRedirect>.
    const tree = ReportServiceButton({ offeringId: 42 }) as ReactElement<{ children: ReactNode }>;
    const button = tree.props.children;
    expect(isValidElement(button)).toBe(true);
    (button as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(mocks.openReportModal).toHaveBeenCalledWith({
      entityType: ReportEntity.ServiceOffering,
      entityId: 42,
    });
  });

  it('shows Report on a storefront card to a visitor, beside Request', () => {
    const html = renderShop();
    expect(html).toMatch(REPORT);
    expect(html).toContain('Request');
  });

  it('shows no Report to the seller on their own storefront', () => {
    mocks.viewerId = SELLER;
    expect(renderShop()).not.toMatch(REPORT);
  });
});
