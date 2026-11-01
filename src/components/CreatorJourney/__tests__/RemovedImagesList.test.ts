// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
const trigger = vi.hoisted(() => vi.fn());
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStore>()),
  dialogStore: { trigger },
}));

import type * as DialogStore from '~/components/Dialog/dialogStore';
import { RemovedImagesView } from '~/components/CreatorJourney/RemovedImagesList';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { EntityType } from '~/shared/utils/prisma/enums';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Removed = React.ComponentProps<typeof RemovedImagesView>['removed'];

const row = (overrides: Partial<Removed['items'][number]>) => ({
  removedAt: new Date('2026-01-02T12:00:00Z'),
  reason: 'Terms of Service violation',
  imageId: null,
  canAppeal: false,
  ...overrides,
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(removed: Removed) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(RemovedImagesView, { removed })
      )
    )
  );
  return [...container.querySelectorAll('tbody tr')].map((tr) => ({
    text: tr.textContent ?? '',
    links: [...tr.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    appeal: [...tr.querySelectorAll('button')].filter((b) => b.textContent === 'Appeal').length,
  }));
}

afterEach(() => {
  trigger.mockClear();
  act(() => root?.unmount());
  container?.remove();
});

describe('RemovedImagesView', () => {
  it('links an existing image, appeals only where offered, and gives a purged one nothing', () => {
    const rows = render({
      total: 3,
      truncated: false,
      items: [
        row({ imageId: 11, canAppeal: true }),
        row({ imageId: 12 }),
        // A purged row offers nothing, whatever the flag says.
        row({ canAppeal: true }),
      ],
    });

    expect(rows.map((r) => [r.links, r.appeal])).toEqual([
      [['/images/11'], 1],
      [['/images/12'], 0],
      [[], 0],
    ]);
    expect(rows[2].text).toContain('Terms of Service violation');
    expect(container?.textContent).toContain('3 removed images.');
  });

  it('opens the appeal dialog for that image', () => {
    render({ total: 1, truncated: false, items: [row({ imageId: 11, canAppeal: true })] });
    const appeal = [...(container?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Appeal'
    );

    act(() => appeal?.click());

    expect(trigger).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        component: AppealDialog,
        props: { entityId: 11, entityType: EntityType.Image },
      })
    );
  });

  it('counts a single image in the singular', () => {
    render({ total: 1, truncated: false, items: [row({})] });

    expect(container?.textContent).toContain('1 removed image.');
  });

  it('says when it shows only the most recent', () => {
    render({ total: 1000, truncated: true, items: [row({})] });

    expect(container?.textContent).toContain('Your 1,000 most recent removed images.');
  });

  it('says so when nothing is left to show', () => {
    expect(render({ total: 0, truncated: false, items: [] })).toEqual([]);
    expect(container?.textContent).toContain('No removed images to show.');
  });
});
