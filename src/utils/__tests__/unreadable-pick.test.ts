import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFileFields,
  probeUnreadablePick,
  splitUnreadablePicks,
  UNREADABLE_PROBE_TIMEOUT_MS,
  unreadablePickMessage,
} from '~/utils/unreadable-pick';

/** A file whose 16-byte probe read rejects with `error`. */
function fileFailingWith(name: string, error: unknown) {
  const file = new File([new Uint8Array(32)], name, { type: 'image/jpeg' });
  file.slice = () => {
    const part = new Blob();
    part.arrayBuffer = () => Promise.reject(error);
    return part;
  };
  return file;
}

describe('probeUnreadablePick', () => {
  it('returns the NotReadableError for a file whose read is refused', async () => {
    const error = new DOMException('could not be read', 'NotReadableError');
    expect(await probeUnreadablePick(fileFailingWith('a.jpg', error))).toBe(error);
  });

  it('treats any other read failure as readable, leaving it to the upload path', async () => {
    const security = new DOMException('denied', 'SecurityError');
    expect(await probeUnreadablePick(fileFailingWith('a.jpg', security))).toBeUndefined();
    expect(await probeUnreadablePick(fileFailingWith('b.jpg', new Error('x')))).toBeUndefined();
  });

  it('is undefined for a file that reads', async () => {
    expect(await probeUnreadablePick(new File(['abc'], 'a.jpg'))).toBeUndefined();
  });

  describe('a read that never settles', () => {
    afterEach(() => vi.useRealTimers());
    /** A file whose probe read stays pending forever, like a cloud photo still downloading. */
    function stalledFile() {
      const file = new File([new Uint8Array(32)], 'slow.jpg', { type: 'image/jpeg' });
      file.slice = () => {
        const part = new Blob();
        part.arrayBuffer = () => new Promise<ArrayBuffer>(() => undefined);
        return part;
      };
      return file;
    }

    it('counts as readable once the probe gives up, and not before', async () => {
      vi.useFakeTimers();
      let result = 'pending';
      void probeUnreadablePick(stalledFile()).then((r) => (result = r ? 'unreadable' : 'readable'));

      await vi.advanceTimersByTimeAsync(UNREADABLE_PROBE_TIMEOUT_MS - 1);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe('readable');
    });

    it('keeps a stalled file with the readable ones', async () => {
      vi.useFakeTimers();
      const slow = stalledFile();
      const split = splitUnreadablePicks([slow]);
      await vi.advanceTimersByTimeAsync(UNREADABLE_PROBE_TIMEOUT_MS);
      expect(await split).toEqual({ readable: [slow], unreadable: [] });
    });

    it('is bounded by a short injected timeout too', async () => {
      expect(await probeUnreadablePick(stalledFile(), 5)).toBeUndefined();
    });
  });

  it('a read that throws instead of rejecting counts as readable', async () => {
    const file = new File(['abc'], 'a.jpg');
    file.slice = () => {
      throw new Error('boom');
    };
    expect(await probeUnreadablePick(file)).toBeUndefined();
  });
});

describe('unreadablePickMessage', () => {
  it.each([
    [
      1,
      true,
      "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.",
    ],
    [
      3,
      true,
      "Your phone's photo picker gave us 3 files we can't open. Choose them from Files instead.",
    ],
    [1, false, "We couldn't open this file. Try choosing it again."],
    [2, false, "We couldn't open 2 of these files. Try choosing them again."],
  ])('%i file(s), android %s', (count, android, expected) => {
    expect(unreadablePickMessage(count, android)).toBe(expected);
  });
});

describe('splitUnreadablePicks', () => {
  it('keeps readable files in order and pairs each unreadable one with its error', async () => {
    const error = new DOMException('could not be read', 'NotReadableError');
    const ok1 = new File(['1'], 'one.jpg');
    const bad = fileFailingWith('bad.jpg', error);
    const ok2 = new File(['2'], 'two.jpg');

    const { readable, unreadable } = await splitUnreadablePicks([ok1, bad, ok2]);
    expect(readable).toEqual([ok1, ok2]);
    expect(unreadable).toEqual([{ file: bad, error }]);
  });
});

describe('boundedFileFields', () => {
  const MB = 1024 * 1024;
  it.each([
    [
      { type: 'image/png', size: 5 * MB - 1 },
      { type: 'image/png', size: '<5MB' },
    ],
    [
      { type: 'image/heic', size: 5 * MB },
      { type: 'image/heic', size: '5-20MB' },
    ],
    [
      { type: 'image/avif', size: 20 * MB },
      { type: 'image/avif', size: '5-20MB' },
    ],
    [
      { type: 'image/webp', size: 20 * MB + 1 },
      { type: 'image/webp', size: '>20MB' },
    ],
    [
      { type: 'application/x-made-up', size: 1 },
      { type: 'other', size: '<5MB' },
    ],
  ])('%o → %o', (file, expected) => {
    expect(boundedFileFields(file)).toEqual(expected);
  });
});
