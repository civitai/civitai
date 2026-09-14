import { describe, expect, test, vi } from 'vitest';
import type * as NotificationsUtils from '~/components/Notifications/notifications.utils';

// Both halves of this layout are inert unless a test imports them: Tailwind
// supplies `shrink-0`, Mantine supplies the tab padding these assertions measure
// against. Without them the tabs never shrink here and the file passes over the
// broken code — verified by reverting `shrink-0` with these imports removed.
import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';

// A count wide enough to matter. `all` is the tab the drawer opens on, so it is
// the one a reader sees selected.
const counts = { all: 1330, comments: 2200, milestones: 0, updates: 0, bounties: 0, buzz: 0 };

vi.mock('~/components/Notifications/notifications.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsUtils>()),
  useQueryNotificationsCount: () => counts,
}));
vi.mock('~/components/Notifications/useNotificationSettings', () => ({
  useNotificationSettings: () => ({
    isLoading: false,
    hasCategory: { Comments: true, Update: true, Milestone: true, Bounty: true, Buzz: true },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, onboarding: 0 }) }));

import { NotificationTabs } from './NotificationTabs';
import { renderWithProviders } from '../../../test/component-setup';

// Narrower than the tabs need, which is the drawer's normal state on a phone —
// the row is a horizontal scroller precisely because they do not fit.
const NARROW = 300;

async function renderTabs() {
  renderWithProviders(
    <div style={{ width: NARROW }}>
      <NotificationTabs onTabChange={() => undefined} />
    </div>
  );

  await vi.waitFor(() => {
    expect(document.body.querySelector('.mantine-Tabs-tab')).toBeTruthy();
  });
}

function allTab() {
  return document.body.querySelector('.mantine-Tabs-tab') as HTMLElement;
}

// Reported 2026-09-10: with `1.33K` in the badge, the selected pill had no right
// padding — the badge sat flush with its edge. `Tabs.List` is `nowrap`, so the
// tabs shrank below their content width; `tabSection` is `shrink-0`, so the
// badge was the part that spilled.
describe('NotificationTabs with a large count', () => {
  test('keeps the count badge inside the tab padding', async () => {
    await renderTabs();

    const tab = allTab();
    const badge = tab.querySelector('.mantine-Badge-root') as HTMLElement;
    expect(badge, 'no count badge rendered').toBeTruthy();

    // Measured on the broken layout the badge ends 15.6px past this edge, i.e.
    // flush with the pill. A revert prints both numbers.
    const paddingRightEdge =
      tab.getBoundingClientRect().right - parseFloat(getComputedStyle(tab).paddingRight);
    expect(badge.getBoundingClientRect().right).toBeLessThanOrEqual(paddingRightEdge + 1);
  });
});
