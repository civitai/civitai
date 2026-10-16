import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';

// Users had no way to report an offering. The server takes offering reports (moderator queue);
// these pin what the report offers and what it files. Where it appears:
// services-report-placement.render.test.ts and deal-gating.render.test.ts.

const mocks = vi.hoisted(() => ({ openReportModal: vi.fn() }));

vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: mocks.openReportModal }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));

const { reportOptionsFor } = await import('~/components/Modals/ReportModal');
const { ReportServiceButton } = await import(
  '~/components/CreatorShop/Services/ReportServiceButton'
);

describe('reporting a service', () => {
  it('offers exactly the reasons the moderator queue takes for a service', () => {
    expect(reportOptionsFor(ReportEntity.ServiceOffering).map(({ key }) => key)).toEqual([
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
});
