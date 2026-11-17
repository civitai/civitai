import { describe, expect, test, vi } from 'vitest';
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
