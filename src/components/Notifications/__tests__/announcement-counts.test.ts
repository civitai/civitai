import { describe, expect, it, vi } from 'vitest';
import {
  clearAnnouncements,
  resolveMarkAsRead,
  withAnnouncementCounts,
} from '~/components/Notifications/notifications.utils';

/**
 * The Announcements tab renders two sets — Civitai's own announcements and the ones from
 * creators you follow — but its badge counted only the first, so a followed creator's post
 * sat in the tab, uncounted, with nothing to tell the reader it was there. Reported by a
 * tester whose badge read 2 with a creator announcement visible below it (FD #72072).
 *
 * These take the followed list and the dismissal set rather than a count, because the bug
 * was the creator half never reaching the counter — an assertion on a sum cannot tell a
 * real count from a zero, so a function that accepts one cannot catch the revert.
 */
describe('withAnnouncementCounts', () => {
  const base = Object.freeze({ all: 5, comment: 3, pendingPlacements: 2 });
  const followed = [{ id: 10 }, { id: 11 }, { id: 12 }];

  it('counts undismissed followed announcements alongside the platform ones', () => {
    const counts = withAnnouncementCounts(base, { platform: 2, followed, dismissedIds: [] });

    expect(counts.announcements).toBe(5);
    expect(counts.all).toBe(10);
  });

  it('counts the creator set when there are no platform announcements', () => {
    // The reported shape once the two official cards expired: drop the creator half and
    // this reads 0, which is the bug rather than an empty tab.
    const counts = withAnnouncementCounts(base, { platform: 0, followed, dismissedIds: [] });

    expect(counts.announcements).toBe(3);
    expect(counts.all).toBe(8);
  });

  it('excludes dismissed followed announcements', () => {
    const counts = withAnnouncementCounts(base, { platform: 0, followed, dismissedIds: [11] });

    expect(counts.announcements).toBe(2);
    expect(counts.all).toBe(7);
  });

  it('reaches zero once every followed announcement is dismissed', () => {
    // The other direction of the same bug: dismiss them all and the badge must clear, or
    // "mark as read" leaves a number behind with nothing left to click.
    const counts = withAnnouncementCounts(base, {
      platform: 0,
      followed,
      dismissedIds: [10, 11, 12],
    });

    expect(counts.announcements).toBe(0);
    expect(counts.all).toBe(5);
  });

  it('leaves the other counts alone', () => {
    const counts = withAnnouncementCounts(base, { platform: 1, followed, dismissedIds: [] });

    expect(counts.comment).toBe(3);
    expect(counts.pendingPlacements).toBe(2);
  });
});

/**
 * The bell renders `all`, which now includes announcements — so a "Mark all as read" that
 * skipped them would drop the bell to a number the tab it was clicked on cannot clear.
 */
describe('resolveMarkAsRead', () => {
  it('clears announcements and the notification feed from the All tab', () => {
    expect(resolveMarkAsRead(null)).toEqual({
      clearsAnnouncements: true,
      marksNotificationsRead: true,
    });
  });

  it('clears only announcements on the Announcements tab', () => {
    expect(resolveMarkAsRead('announcements')).toEqual({
      clearsAnnouncements: true,
      marksNotificationsRead: false,
    });
  });

  it('leaves announcements alone on a category tab', () => {
    // A category tab's button is scoped to that category, and its count never included
    // announcements — clearing them there would dismiss cards the reader never saw.
    expect(resolveMarkAsRead('Comment')).toEqual({
      clearsAnnouncements: false,
      marksNotificationsRead: true,
    });
  });
});

describe('clearAnnouncements', () => {
  const spies = () => ({ platform: vi.fn(), creator: vi.fn() });

  it('dismisses both sets', () => {
    // Dropping either call is the "badge goes up and will not come down" bug, and both
    // dismissers write to browser storage and return nothing — so the call is the only
    // observable there is.
    const dismiss = spies();

    clearAnnouncements({ platformIds: [1, 2], creatorIds: [10, 11] }, dismiss);

    expect(dismiss.platform).toHaveBeenCalledTimes(1);
    expect(dismiss.platform).toHaveBeenCalledWith([1, 2]);
    expect(dismiss.creator).toHaveBeenCalledTimes(1);
    expect(dismiss.creator).toHaveBeenCalledWith([10, 11]);
  });

  it('does not cross the two sets over', () => {
    // Both dismissers take number[], so a swap typechecks and would dismiss each half
    // against the other's store — silently, since ids that match nothing are a no-op.
    const dismiss = spies();

    clearAnnouncements({ platformIds: [1], creatorIds: [10] }, dismiss);

    expect(dismiss.platform).not.toHaveBeenCalledWith([10]);
    expect(dismiss.creator).not.toHaveBeenCalledWith([1]);
  });
});
