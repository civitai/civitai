import Router from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as NotificationThumbnails from '~/components/Notifications/notification-thumbnails';

// The thumbnail hook is the only tRPC caller in this tree; the id normaliser
// beside it stays real, since the list keys its lookups with it.
vi.mock('~/components/Notifications/notification-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationThumbnails>()),
  useNotificationThumbnails: () => new Map(),
}));

import { NotificationList } from './NotificationList';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { renderWithProviders } from '../../../test/component-setup';

// A reaction milestone: the shape the notifications DB actually stores. Its url
// exists nowhere in `details` — `getNotificationMessage` derives it.
const reactionMilestone = {
  id: 1,
  type: 'image-reaction-milestone',
  category: 'Milestone',
  createdAt: new Date('2026-09-10T00:00:00Z'),
  read: false,
  details: {
    version: 2,
    imageId: 123,
    postId: 456,
    models: ['Some Checkpoint'],
    reactionCount: 10,
  },
} as any;

async function renderRow(onItemClick: (...args: any[]) => void) {
  // `DaysFromNow` throws without it, and React unmounts the whole root on an
  // uncaught render error — so the symptom is an empty body, not a stack.
  renderWithProviders(
    <IsClientProvider>
      <NotificationList items={[reactionMilestone]} searchText="" onItemClick={onItemClick} />
    </IsClientProvider>
  );

  // Without this the row is read before React has committed and every assertion
  // below reports `Cannot read properties of null` instead of its own numbers.
  await vi.waitFor(() => {
    expect(
      document.body.querySelector('a[href]'),
      `no notification row rendered; body was: ${document.body.textContent}`
    ).toBeTruthy();
  });

  return document.body.querySelector('a[href]') as HTMLElement;
}

// Reported 2026-09-10 while reproducing ClickUp 868m2ay0a: on mobile, tapping a
// notification navigates but leaves the full-screen drawer covering the page.
// `NotificationsComposed` gated its `onClose()` on `notification.details.url`,
// which only announcements carry, so the panel closed for announcements alone.
describe('NotificationList click payload', () => {
  test('hands back the derived url, so the panel knows it navigated', async () => {
    const onItemClick = vi.fn();
    const row = await renderRow(onItemClick);

    row.click();

    // `objectContaining`, because the list hands back the item with the resolved
    // message attached; the second argument is what this file is about.
    expect(onItemClick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), {
      keepOpened: false,
      url: '/images/123?postId=456',
    });
  });

  test('keeps the panel open on a middle click', async () => {
    const onItemClick = vi.fn();
    const row = await renderRow(onItemClick);

    row.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    expect(onItemClick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), {
      keepOpened: true,
      url: '/images/123?postId=456',
    });
  });
});

// An early-access invitation is sent as `system-announcement`; a red alert on it
// reads as "you are in trouble". Every other type keeps its own marker, never red.
describe('NotificationList announcement icon', () => {
  const announcement = {
    id: 2,
    type: 'system-announcement',
    category: 'System',
    createdAt: new Date('2026-09-10T00:00:00Z'),
    read: false,
    details: { message: 'Try new Civitai features first', url: '/content/early-access' },
  } as any;
  const features = {
    id: 3,
    type: 'civitai-features',
    category: 'System',
    createdAt: new Date('2026-09-10T00:00:00Z'),
    read: false,
    details: { featureBlurb: 'a thing', releaseSlug: 'a-thing' },
  } as any;

  async function renderItems(items: any[]) {
    renderWithProviders(
      <IsClientProvider>
        <NotificationList items={items} searchText="" onItemClick={vi.fn()} />
      </IsClientProvider>
    );
    await vi.waitFor(() => {
      expect(
        document.body.querySelector('a[href]'),
        `body: ${document.body.textContent}`
      ).toBeTruthy();
    });
  }

  test('announcement shows the neutral megaphone, not the red alert', async () => {
    await renderItems([announcement]);
    expect(document.body.querySelector('.tabler-icon-speakerphone')).toBeTruthy();
    expect(document.body.querySelector('.tabler-icon-alert-octagon')).toBeNull();
  });

  test('other system types never get the alert or the megaphone', async () => {
    await renderItems([features]);
    expect(document.body.querySelector('.tabler-icon-bell')).toBeTruthy();
    expect(document.body.querySelector('.tabler-icon-speakerphone')).toBeNull();
    expect(document.body.querySelector('.tabler-icon-alert-octagon')).toBeNull();
  });
});

// A mature item's appeal result links to .red, which the client router cannot reach.
describe('NotificationList link to another host', () => {
  const RED_URL = 'https://civitai.red.test/models/7';
  const appealResult = (url?: string) =>
    ({
      id: 4,
      type: 'entity-appeal-resolved',
      category: 'Moderation',
      createdAt: new Date('2026-09-10T00:00:00Z'),
      read: false,
      details: { entityType: 'Model', entityId: 7, status: 'Approved', ...(url && { url }) },
    } as any);

  async function clickRow(item: any, onItemClick: (...args: any[]) => unknown) {
    renderWithProviders(
      <IsClientProvider>
        <NotificationList items={[item]} searchText="" onItemClick={onItemClick as any} />
      </IsClientProvider>
    );
    await vi.waitFor(() => {
      expect(
        document.body.querySelector('a[href]'),
        `body: ${document.body.textContent}`
      ).toBeTruthy();
    });
    vi.mocked(Router.push).mockClear();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    // If the list ever lets the anchor navigate, a test fails here instead of the page unloading the runner.
    const stayOnPage = (e: Event) => e.preventDefault();
    window.addEventListener('click', stayOnPage);
    try {
      (document.body.querySelector('a[href]') as HTMLAnchorElement).click();
    } finally {
      window.removeEventListener('click', stayOnPage);
    }
    return { open, push: vi.mocked(Router.push) };
  }

  afterEach(() => vi.restoreAllMocks());

  test('leaves the origin for an absolute .red url only once mark-read has landed', async () => {
    let markRead!: () => void;
    const { open, push } = await clickRow(
      appealResult(RED_URL),
      () => new Promise<void>((resolve) => (markRead = resolve))
    );

    expect(open).not.toHaveBeenCalled();
    markRead();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(RED_URL, '_self'));
    expect(push).not.toHaveBeenCalled();
  });

  test('still leaves when mark-read fails', async () => {
    const { open } = await clickRow(appealResult(RED_URL), () => Promise.reject(new Error('down')));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(RED_URL, '_self'));
  });

  test('still leaves when mark-read never answers', async () => {
    const { open } = await clickRow(appealResult(RED_URL), () => new Promise(() => undefined));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(RED_URL, '_self'), { timeout: 5000 });
  });

  test('a relative url stays on the client router', async () => {
    const { open, push } = await clickRow(appealResult(), () => undefined);
    expect(push).toHaveBeenCalledWith('/models/7');
    expect(open).not.toHaveBeenCalled();
  });
});
