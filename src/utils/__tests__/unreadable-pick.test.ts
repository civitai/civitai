import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFileFields,
  createPickUrls,
  isPickSnapshot,
  markInMemory,
  pickOriginal,
  isReadFailure,
  probeUnreadablePick,
  snapshotPick,
  splitUnreadablePicks,
  UNREADABLE_PROBE_TIMEOUT_MS,
  unreadablePickMessage,
} from '~/utils/unreadable-pick';

const MAX_BYTES = 1024;

/** A file whose reads, whole or sliced, reject with `error`. */
function fileFailingWith(name: string, error: unknown) {
  const file = new File([new Uint8Array(32)], name, { type: 'image/jpeg' });
  file.slice = () => {
    const part = new Blob();
    part.arrayBuffer = () => Promise.reject(error);
    return part;
  };
  file.arrayBuffer = () => Promise.reject(error);
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
      slow.arrayBuffer = () => new Promise<ArrayBuffer>(() => undefined);
      const split = splitUnreadablePicks([slow], { maxBytes: MAX_BYTES });
      await vi.advanceTimersByTimeAsync(UNREADABLE_PROBE_TIMEOUT_MS);
      const { readable, unreadable } = await split;
      expect(readable[0]).toBe(slow);
      expect(unreadable).toEqual([]);
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

    const { readable, unreadable, replacements } = await splitUnreadablePicks([ok1, bad, ok2], {
      maxBytes: MAX_BYTES,
    });
    // Not images, so kept as they are; compared by identity (toEqual finds any two Files equal).
    expect(readable).toHaveLength(2);
    expect(readable[0]).toBe(ok1);
    expect(readable[1]).toBe(ok2);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].file).toBe(bad);
    expect(unreadable[0].error).toBe(error);
    expect([...replacements.keys()]).toHaveLength(2);
    expect(replacements.get(ok1)).toBe(ok1);
    expect(replacements.get(ok2)).toBe(ok2);
  });

  it('replaces a readable image with its in-memory copy', async () => {
    const photo = new File(['photo'], 'p.jpg', { type: 'image/jpeg' });
    const { readable, replacements } = await splitUnreadablePicks([photo], { maxBytes: MAX_BYTES });
    expect(readable).toHaveLength(1);
    expect(readable[0]).not.toBe(photo);
    expect(replacements.get(photo)).toBe(readable[0]);
  });
});

describe('splitUnreadablePicks concurrency', () => {
  it('reads at most four images in full at once, and still reads them all', async () => {
    let inFlight = 0;
    let peak = 0;
    const files = Array.from({ length: 9 }, (_, i) => {
      const file = new File([`photo ${i}`], `p${i}.jpg`, { type: 'image/jpeg' });
      const read = file.arrayBuffer.bind(file);
      file.arrayBuffer = async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return read();
      };
      return file;
    });
    const { readable } = await splitUnreadablePicks(files, { maxBytes: MAX_BYTES });
    expect(peak).toBe(4);
    expect(await Promise.all(readable.map((f) => f.text()))).toEqual(
      files.map((_, i) => `photo ${i}`)
    );
  });

  /** Image files whose full reads stay pending until `settleAll`, counting reads in flight. */
  function stallingFiles(count: number) {
    const reads = { inFlight: 0, peak: 0, started: 0 };
    const pending: (() => void)[] = [];
    const files = Array.from({ length: count }, (_, i) => {
      const file = new File([`photo ${i}`], `p${i}.jpg`, { type: 'image/jpeg' });
      file.arrayBuffer = () => {
        reads.started++;
        reads.peak = Math.max(reads.peak, ++reads.inFlight);
        return new Promise<ArrayBuffer>((_, reject) =>
          pending.push(() => {
            reads.inFlight--;
            reject(new DOMException('aborted', 'AbortError'));
          })
        );
      };
      return file;
    });
    const settleAll = async () => {
      for (const settle of pending.splice(0)) settle();
      await new Promise((r) => setTimeout(r, 20));
    };
    return { files, reads, settleAll };
  }

  it('keeps a timed-out read counted until it settles: twelve stalled picks never read more than four at once', async () => {
    const { files, reads, settleAll } = stallingFiles(12);
    const { readable, unreadable } = await splitUnreadablePicks(files, {
      maxBytes: MAX_BYTES,
      timeoutMs: 20,
    });
    // Every pick goes on as the device's own file; the ones never read are given up unread.
    expect(unreadable).toEqual([]);
    expect(readable).toHaveLength(12);
    readable.forEach((file, i) => expect(file).toBe(files[i]));
    expect(reads.peak).toBe(4);
    expect(reads.started).toBe(4);

    // The stalled reads settling starts none of the picks already given up.
    await settleAll();
    expect(reads.started).toBe(4);
    expect(reads.inFlight).toBe(0);
  });

  it('a slot frees up once its stalled read settles, and the picks still waiting are read', async () => {
    const stalled = stallingFiles(1);
    const healthy = Array.from(
      { length: 6 },
      (_, i) => new File([`ok ${i}`], `ok${i}.jpg`, { type: 'image/jpeg' })
    );
    const split = splitUnreadablePicks([...stalled.files, ...healthy], {
      maxBytes: MAX_BYTES,
      timeoutMs: 20,
    });
    const { readable } = await split;
    expect(readable[0]).toBe(stalled.files[0]);
    // With one slot held, the other three still copy every healthy pick.
    expect(readable.slice(1).every((f) => isPickSnapshot(f))).toBe(true);
    expect(await Promise.all(readable.slice(1).map((f) => f.text()))).toEqual(
      healthy.map((_, i) => `ok ${i}`)
    );
    await stalled.settleAll();
  });

  it('resolves at once for an empty pick', async () => {
    expect(await splitUnreadablePicks([], { maxBytes: MAX_BYTES })).toEqual({
      readable: [],
      unreadable: [],
      replacements: new Map(),
    });
  });
});

describe('pickOriginal / markInMemory', () => {
  it('maps a pick-time copy to the File it was taken from, and any other file to itself', async () => {
    const photo = new File(['photo'], 'p.jpg', { type: 'image/jpeg' });
    const { file: copy } = await snapshotPick(photo, { maxBytes: MAX_BYTES });
    expect(copy).not.toBe(photo);
    expect(pickOriginal(copy!)).toBe(photo);
    expect(pickOriginal(photo)).toBe(photo);
  });

  it('marks a file built in memory as one', () => {
    const fetched = new File(['x'], 'x.jpg', { type: 'image/jpeg' });
    expect(isPickSnapshot(fetched)).toBe(false);
    expect(markInMemory(fetched)).toBe(fetched);
    expect(isPickSnapshot(fetched)).toBe(true);
  });
});

describe('createPickUrls', () => {
  afterEach(() => vi.restoreAllMocks());

  it('revokes a released url at once when nothing holds it', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const urls = createPickUrls();
    const url = urls.create(new Blob(['x']));
    expect(revoke).not.toHaveBeenCalled();
    urls.release(url);
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('waits for every hold to settle, rejected or not, before revoking', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const urls = createPickUrls();
    const url = urls.create(new Blob(['x']));
    let finish!: () => void;
    let fail!: (e: Error) => void;
    urls.hold(url, new Promise<void>((r) => (finish = r)));
    const failing = new Promise<void>((_, reject) => (fail = reject));
    failing.catch(() => undefined);
    urls.hold(url, failing);
    urls.release(url);
    await Promise.resolve();
    expect(revoke).not.toHaveBeenCalled();
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(revoke).not.toHaveBeenCalled();
    fail(new Error('read failed'));
    await new Promise((r) => setTimeout(r, 0));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('a settled hold on a url not yet released does not revoke it', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const urls = createPickUrls();
    const url = urls.create(new Blob(['x']));
    urls.hold(url, Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));
    expect(revoke).not.toHaveBeenCalled();
  });

  it('releaseAllBut releases only the urls not in use, and never one it did not make', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const urls = createPickUrls();
    const kept = urls.create(new Blob(['a']));
    const dropped = urls.create(new Blob(['b']));
    urls.releaseAllBut(new Set([kept, 'https://example.test/x.jpg']));
    expect(revoke.mock.calls).toEqual([[dropped]]);
    urls.hold('blob:not-ours', Promise.resolve());
    urls.release('blob:not-ours');
    expect(revoke.mock.calls).toEqual([[dropped]]);
  });
});

describe('snapshotPick', () => {
  const imageFile = (bytes: BlobPart, name = 'p.jpg') =>
    new File([bytes], name, { type: 'image/jpeg', lastModified: 1_700_000_000_000 });

  it('replaces an image with a copy of its bytes that keeps its name, type and date', async () => {
    const photo = imageFile('photo bytes');
    const { file, error } = await snapshotPick(photo, { maxBytes: MAX_BYTES });
    expect(error).toBeUndefined();
    expect(file).not.toBe(photo);
    expect(file).toBeInstanceOf(File);
    expect(await file!.text()).toBe('photo bytes');
    expect([file!.name, file!.type, file!.lastModified]).toEqual([
      'p.jpg',
      'image/jpeg',
      1_700_000_000_000,
    ]);
    expect(isPickSnapshot(file!)).toBe(true);
    expect(isPickSnapshot(photo)).toBe(false);
  });

  it('marks no file it keeps as it is as a copy', async () => {
    const big = imageFile(new Uint8Array(MAX_BYTES + 1));
    const video = new File(['v'], 'v.mp4', { type: 'video/mp4' });
    const failing = imageFile('x');
    failing.arrayBuffer = () => Promise.reject(new DOMException('denied', 'SecurityError'));
    for (const original of [big, video, failing]) {
      const { file } = await snapshotPick(original, { maxBytes: MAX_BYTES });
      expect(file).toBe(original);
      expect(isPickSnapshot(original)).toBe(false);
    }
  });

  it('does not read an image over the size limit in full: it is probed and kept', async () => {
    const big = imageFile(new Uint8Array(MAX_BYTES + 1));
    const fullRead = vi.spyOn(big, 'arrayBuffer');
    const { file } = await snapshotPick(big, { maxBytes: MAX_BYTES });
    expect(file).toBe(big);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('reads an image of exactly the size limit in full', async () => {
    const atLimit = imageFile(new Uint8Array(MAX_BYTES));
    const { file } = await snapshotPick(atLimit, { maxBytes: MAX_BYTES });
    expect(file).not.toBe(atLimit);
    expect(file?.size).toBe(MAX_BYTES);
  });

  it('only probes a file that is not an image', async () => {
    const video = new File(['v'], 'v.mp4', { type: 'video/mp4' });
    const fullRead = vi.spyOn(video, 'arrayBuffer');
    expect((await snapshotPick(video, { maxBytes: MAX_BYTES })).file).toBe(video);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('returns the NotReadableError of a full read that is refused', async () => {
    const error = new DOMException('could not be read', 'NotReadableError');
    const photo = imageFile('x');
    photo.arrayBuffer = () => Promise.reject(error);
    const result = await snapshotPick(photo, { maxBytes: MAX_BYTES });
    expect(result.file).toBeUndefined();
    expect(result.error).toBe(error);
  });

  it('keeps the original for any other read failure', async () => {
    const photo = imageFile('x');
    photo.arrayBuffer = () => Promise.reject(new DOMException('denied', 'SecurityError'));
    expect((await snapshotPick(photo, { maxBytes: MAX_BYTES })).file).toBe(photo);
  });

  it('keeps the original when the full read does not settle in time', async () => {
    const photo = imageFile('x');
    photo.arrayBuffer = () => new Promise<ArrayBuffer>(() => undefined);
    expect((await snapshotPick(photo, { maxBytes: MAX_BYTES, timeoutMs: 5 })).file).toBe(photo);
  });
});

describe('isReadFailure', () => {
  it.each([
    ['a NotReadableError', new DOMException('x', 'NotReadableError'), true],
    ['a TypeError (a blob: fetch, Chromium)', new TypeError('Failed to fetch'), true],
    [
      'a TypeError (a blob: fetch, Firefox)',
      new TypeError('NetworkError when attempting to fetch resource.'),
      true,
    ],
    ['a TypeError (a blob: fetch, WebKit)', new TypeError('Load failed'), true],
    [
      'any other TypeError (a bug in the reader)',
      new TypeError("Cannot read properties of undefined (reading 'width')"),
      false,
    ],
    ['an <img> load error', new Error('Image failed to load', { cause: new Event('error') }), true],
    ['an Error without an Event cause', new Error('Image failed to load'), false],
    ['an EncodingError', new DOMException('x', 'EncodingError'), false],
    ['undefined', undefined, false],
  ])('%s → %s', (_, error, expected) => {
    expect(isReadFailure(error)).toBe(expected);
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
