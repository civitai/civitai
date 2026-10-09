import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: () => load() }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { getVisibleDecorationEvents } = await import('~/server/events/event-decoration-access');
const c = await import('~/shared/constants/birthday2026.constants');

/**
 * Which events' decorations a viewer sees on the feeds. Before launch that is the line between a
 * tester's party hats and the public's feed, so anything that goes wrong deciding it must hide the
 * decorations (and the page still render), never show them.
 */
const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * 60 * 60 * 1000);
const event = {
  name: c.BIRTHDAY_2026_EVENT,
  startDate: c.BIRTHDAY_2026_STARTS_AT,
  endDate: c.BIRTHDAY_2026_ENDS_AT,
  featureFlag: 'birthday2026' as const,
  previewFrom: c.BIRTHDAY_2026_PREVIEW_FROM,
};

beforeEach(() => {
  vi.clearAllMocks();
  testerFlag.reset({ testers: [7] });
  load.mockResolvedValue([event]);
});

describe('getVisibleDecorationEvents', () => {
  it('shows a tester the event during the preview, and nobody else', async () => {
    expect([...(await getVisibleDecorationEvents('Image', { id: 7 }, PREVIEW))]).toEqual([
      BIRTHDAY_2026_EVENT,
    ]);
    expect(await getVisibleDecorationEvents('Image', { id: 8 }, PREVIEW)).toEqual(new Set());
    expect(await getVisibleDecorationEvents('Image', undefined, PREVIEW)).toEqual(new Set());
  });

  it('hides decorations, and logs, when the events cannot be loaded', async () => {
    load.mockRejectedValue(new Error('engine failed to load'));
    expect(await getVisibleDecorationEvents('Image', { id: 7 }, PREVIEW)).toEqual(new Set());
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'event-decoration-access', event: BIRTHDAY_2026_EVENT })
    );
  });
});
