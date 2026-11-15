import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TurfWatchHub, retainTurfWatchHub } from '~/components/HatTurf/turf-watch-hub';

type Sent = { event: string; imageIds: number[] };

const options = (sent: Sent[], event = 'birthday2026') => ({
  event,
  send: (input: Sent) => void sent.push(input),
  refreshMs: 60_000,
  coalesceMs: 250,
  minGapMs: 2_000,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TurfWatchHub', () => {
  test('two providers on one page: one mark with the union of their on-screen ids', () => {
    const sent: Sent[] = [];
    const hub = new TurfWatchHub(options(sent));
    // A home block shows 101, 102, 103; a second block shows 103 (again) and 104.
    [101, 102, 103].forEach((id) => hub.retain(id));
    [103, 104].forEach((id) => hub.retain(id));
    vi.advanceTimersByTime(249);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ event: 'birthday2026', imageIds: [101, 102, 103, 104] }]);
    hub.dispose();
  });

  test('re-marks the whole union once per interval, not before', () => {
    const sent: Sent[] = [];
    const hub = new TurfWatchHub(options(sent));
    [7, 8, 9].forEach((id) => hub.retain(id));
    vi.advanceTimersByTime(250);
    sent.length = 0;
    vi.advanceTimersByTime(60_000 - 250 - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ event: 'birthday2026', imageIds: [7, 8, 9] }]);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([
      { event: 'birthday2026', imageIds: [7, 8, 9] },
      { event: 'birthday2026', imageIds: [7, 8, 9] },
    ]);
    hub.dispose();
  });

  test('an id both providers show stays marked until the last one lets go', () => {
    const sent: Sent[] = [];
    const hub = new TurfWatchHub(options(sent));
    hub.retain(5);
    hub.retain(5);
    hub.retain(6);
    vi.advanceTimersByTime(250);
    hub.release(5);
    vi.advanceTimersByTime(60_000);
    expect(sent.at(-1)).toEqual({ event: 'birthday2026', imageIds: [5, 6] });
    hub.release(5);
    vi.advanceTimersByTime(60_000);
    expect(sent.at(-1)).toEqual({ event: 'birthday2026', imageIds: [6] });
    hub.dispose();
  });

  test('more than 50 ids go out 50 to a call (the schema cap)', () => {
    const sent: Sent[] = [];
    const hub = new TurfWatchHub(options(sent));
    for (let id = 1; id <= 120; id++) hub.retain(id);
    vi.advanceTimersByTime(250);
    expect(sent.map((s) => s.imageIds.length)).toEqual([50, 50, 20]);
    expect(sent[2].imageIds[0]).toBe(101);
    hub.dispose();
  });

  test('new ids after a mark wait for the 2s gap: one mark, not one per card', () => {
    const sent: Sent[] = [];
    const hub = new TurfWatchHub(options(sent));
    hub.retain(21);
    vi.advanceTimersByTime(250);
    for (const id of [22, 23, 24]) {
      hub.retain(id);
      vi.advanceTimersByTime(500);
    }
    // 250ms + 2000ms after the first mark is 2250ms; 1750ms has passed.
    expect(sent.map((s) => s.imageIds)).toEqual([[21]]);
    vi.advanceTimersByTime(500);
    expect(sent.map((s) => s.imageIds)).toEqual([[21], [22, 23, 24]]);
    hub.dispose();
  });

  test('tells subscribers of ids marked again after a gap, never of first marks', () => {
    const sent: Sent[] = [];
    const heard: number[][] = [];
    const hub = new TurfWatchHub(options(sent));
    hub.subscribe((ids) => heard.push(ids));
    hub.retain(31);
    hub.retain(32);
    vi.advanceTimersByTime(250);
    expect(heard).toEqual([]);
    hub.release(32);
    vi.advanceTimersByTime(2_000);
    hub.retain(32);
    vi.advanceTimersByTime(2_000);
    expect(heard).toEqual([[32]]);
    expect(sent.map((s) => s.imageIds)).toEqual([[31, 32], [32]]);
    hub.dispose();
  });
});

describe('retainTurfWatchHub', () => {
  test('providers of one event share one hub; the last release stops its timers', () => {
    const sent: Sent[] = [];
    const a = retainTurfWatchHub(options(sent, 'shared-event'));
    const b = retainTurfWatchHub(options(sent, 'shared-event'));
    const other = retainTurfWatchHub(options(sent, 'other-event'));
    expect(b.hub).toBe(a.hub);
    expect(other.hub).not.toBe(a.hub);
    a.hub.retain(1);
    other.hub.retain(2);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([
      { event: 'shared-event', imageIds: [1] },
      { event: 'other-event', imageIds: [2] },
    ]);
    other.release();
    sent.length = 0;

    a.release();
    // Released twice by the same holder: counted once, so b still holds the hub.
    a.release();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([{ event: 'shared-event', imageIds: [1] }]);

    b.release();
    sent.length = 0;
    vi.advanceTimersByTime(120_000);
    expect(sent).toEqual([]);
    // A provider mounting later gets a fresh hub.
    const c = retainTurfWatchHub(options(sent, 'shared-event'));
    expect(c.hub).not.toBe(a.hub);
    c.release();
  });
});
