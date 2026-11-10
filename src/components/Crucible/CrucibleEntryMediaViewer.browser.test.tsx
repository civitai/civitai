import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const openReportModal = vi.hoisted(() => vi.fn());
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeMediaModule>()),
  EdgeMedia2: () => null,
}));

const { CrucibleEntryMediaViewer } = await import('~/components/Crucible/CrucibleEntryMediaViewer');

const media = [1, 2].map((n) => ({
  entryId: n,
  imageId: n * 10,
  url: `image-${n}`,
  name: null,
  type: 'image' as const,
}));

function Harness() {
  const [index, setIndex] = useState<number | null>(0);
  return (
    <CrucibleEntryMediaViewer
      media={media}
      index={index}
      onIndexChange={setIndex}
      onClose={() => setIndex(null)}
    />
  );
}

const report = () => document.querySelector<HTMLButtonElement>('[aria-label="Report"]')!;

beforeEach(() => openReportModal.mockReset());

describe('CrucibleEntryMediaViewer — reporting', () => {
  test('reports the image on display and follows paging', async () => {
    renderWithProviders(<Harness />);

    await vi.waitFor(() => expect(report()).toBeTruthy());
    report().click();
    expect(openReportModal).toHaveBeenLastCalledWith({ entityType: 'image', entityId: 10 });

    document.querySelector<HTMLButtonElement>('[aria-label="Next entry"]')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('2 / 2'));
    report().click();
    expect(openReportModal).toHaveBeenLastCalledWith({ entityType: 'image', entityId: 20 });
  });
});
