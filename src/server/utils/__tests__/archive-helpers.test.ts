import archiver from 'archiver';
import fs from 'fs';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Writable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import plimit from 'p-limit';
import {
  createBoundedArchive,
  MAX_PENDING_ARCHIVE_ENTRIES,
  MEDIA_ARCHIVE_COMPRESSION_LEVEL,
} from '~/server/utils/archive-helpers';

/**
 * These tests pin the memory shape of archive building.
 *
 * The defect they exist for: `archive.append()` is fire-and-forget onto an unbounded internal
 * queue, so a fast producer (network) in front of a slow consumer (deflate) retains every source
 * buffer at once. Memory then tracks total downloaded bytes rather than staying flat, which is
 * how archiving one account with a very large media library exhausts a container's memory limit.
 * The buffers are external/off-heap, so a V8 old-space cap never engages first.
 */

// Deliberately awkward numbers: the entry count is not a multiple of the bound, and the entry
// size is not a round power of two, so a fixture cannot land exactly on the boundary it tests.
const ENTRY_COUNT = 37;
const ENTRY_BYTES = 193 * 1024;
const BOUND = 5;

// Incompressible bytes, i.e. the JPEG/WebP case. Level-9 deflate on this is pure CPU burn, which
// is exactly what makes the consumer the bottleneck in production.
let pool: Buffer;
let tmpDir: string;

beforeAll(() => {
  pool = randomBytes(ENTRY_BYTES + ENTRY_COUNT);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-helpers-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const entryBuffer = (i: number) => Buffer.from(pool.subarray(i, i + ENTRY_BYTES));

/** A sink slow enough that a zero-latency producer will outrun it. */
function slowSink(delayMs = 5) {
  return new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(callback, delayMs);
    },
  });
}

/**
 * Counts entries appended vs. entries the archiver has finished processing, independently of any
 * bookkeeping inside `createBoundedArchive`. Asserting on the helper's own `peakPendingEntries`
 * alone would be asserting its self-report; this watches the archiver directly.
 */
function watchOutstanding(archive: archiver.Archiver) {
  const state = { appended: 0, processed: 0, peak: 0 };
  archive.on('entry', () => {
    state.processed++;
  });
  return {
    state,
    recordAppend() {
      state.appended++;
      const outstanding = state.appended - state.processed;
      if (outstanding > state.peak) state.peak = outstanding;
    },
  };
}

describe('createBoundedArchive', () => {
  it('keeps appended-but-unprocessed entries — and therefore retained bytes — bounded', async () => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(slowSink());
    const watcher = watchOutstanding(archive);

    const bounded = createBoundedArchive({ archive, maxPendingEntries: BOUND });

    const limit = plimit(10);
    await Promise.all(
      Array.from({ length: ENTRY_COUNT }, (_, i) =>
        limit(async () => {
          const buffer = entryBuffer(i);
          await bounded.append(buffer, { name: `entry-${i}.bin` });
          watcher.recordAppend();
        })
      )
    );
    await bounded.finalize();

    // The claim under test. Against the unbounded pattern this reads ENTRY_COUNT — see the
    // negative control below, which is what proves this assertion can go red at all.
    expect(watcher.state.peak).toBeLessThanOrEqual(BOUND);

    // Restated as memory, which is the quantity that actually killed the process: peak retained
    // source bytes must be a function of the bound, not of how many images the account has.
    const peakRetainedBytes = watcher.state.peak * ENTRY_BYTES;
    expect(peakRetainedBytes).toBeLessThanOrEqual(BOUND * ENTRY_BYTES);
    expect(peakRetainedBytes).toBeLessThan(ENTRY_COUNT * ENTRY_BYTES);

    // Backpressure must not drop work.
    expect(watcher.state.processed).toBe(ENTRY_COUNT);
    expect(bounded.pendingEntries).toBe(0);
    expect(bounded.peakPendingEntries).toBeLessThanOrEqual(BOUND);
  });

  it('NEGATIVE CONTROL: the same measurement reads unbounded for a plain archive.append loop', async () => {
    // This is the pre-fix code shape, reproduced verbatim: append inside a p-limit map, no
    // awaiting of the compressor. If this ever came back bounded, the assertion in the test above
    // would be measuring nothing.
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(slowSink());
    const watcher = watchOutstanding(archive);

    const limit = plimit(10);
    await Promise.all(
      Array.from({ length: ENTRY_COUNT }, (_, i) =>
        limit(async () => {
          const buffer = entryBuffer(i);
          archive.append(buffer, { name: `entry-${i}.bin` });
          watcher.recordAppend();
        })
      )
    );

    expect(watcher.state.peak).toBeGreaterThan(BOUND);
    expect(watcher.state.peak).toBe(ENTRY_COUNT);

    await archive.finalize();
  });

  it('preserves the entry set exactly — every appended entry lands in the archive intact', async () => {
    const outPath = path.join(tmpDir, 'entry-set.zip');
    const archive = archiver('zip', { zlib: { level: MEDIA_ARCHIVE_COMPRESSION_LEVEL } });
    const output = fs.createWriteStream(outPath);
    archive.pipe(output);

    const bounded = createBoundedArchive({ archive, output, maxPendingEntries: BOUND });

    for (let i = 0; i < ENTRY_COUNT; i++) {
      await bounded.append(entryBuffer(i), { name: `entry-${i}.bin` });
    }
    await bounded.finalize();

    const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(ENTRY_COUNT);
    expect(names).toEqual(Array.from({ length: ENTRY_COUNT }, (_, i) => `entry-${i}.bin`).sort());

    // Spot-check content fidelity at both ends and the middle rather than trusting names alone.
    for (const i of [0, Math.floor(ENTRY_COUNT / 2), ENTRY_COUNT - 1]) {
      const content = await zip.files[`entry-${i}.bin`].async('nodebuffer');
      expect(content.equals(entryBuffer(i))).toBe(true);
    }
  });

  it('finalize() does not resolve until the output sink has flushed and closed', async () => {
    const outPath = path.join(tmpDir, 'flushed.zip');
    const archive = archiver('zip', { zlib: { level: MEDIA_ARCHIVE_COMPRESSION_LEVEL } });
    const output = fs.createWriteStream(outPath);
    archive.pipe(output);

    const bounded = createBoundedArchive({ archive, output, maxPendingEntries: BOUND });
    for (let i = 0; i < ENTRY_COUNT; i++) {
      await bounded.append(entryBuffer(i), { name: `entry-${i}.bin` });
    }
    await bounded.finalize();

    // Opening a read stream at this instant is what the caller does next, so the file has to be
    // whole here — not "whole shortly afterwards".
    const sizeAtResolve = fs.statSync(outPath).size;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fs.statSync(outPath).size).toBe(sizeAtResolve);

    const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
    expect(Object.keys(zip.files)).toHaveLength(ENTRY_COUNT);
  });

  it('NEGATIVE CONTROL: an un-awaited finalize leaves a short file at the same instant', async () => {
    // The pre-fix shape: `archive.finalize()` then straight into `fs.createReadStream(outPath)`.
    const outPath = path.join(tmpDir, 'unawaited.zip');
    const archive = archiver('zip', { zlib: { level: MEDIA_ARCHIVE_COMPRESSION_LEVEL } });
    const output = fs.createWriteStream(outPath);
    archive.pipe(output);

    const closed = new Promise<void>((resolve) => output.once('close', () => resolve()));
    for (let i = 0; i < ENTRY_COUNT; i++)
      archive.append(entryBuffer(i), { name: `entry-${i}.bin` });

    archive.finalize(); // deliberately not awaited
    const sizeAtReturn = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;

    await closed;
    const finalSize = fs.statSync(outPath).size;

    expect(finalSize).toBeGreaterThan(0);
    expect(sizeAtReturn).toBeLessThan(finalSize);
  });

  it('rejects appends after an archive error instead of throwing from the event handler', async () => {
    const archive = archiver('zip', { zlib: { level: MEDIA_ARCHIVE_COMPRESSION_LEVEL } });
    archive.pipe(slowSink(0));
    const bounded = createBoundedArchive({ archive, maxPendingEntries: BOUND });

    await bounded.append(entryBuffer(0), { name: 'ok.bin' });
    // A nameless entry makes archiver emit `error`; the previous `throw err` listener turned that
    // into an uncaught exception from inside archiver's async internals.
    archive.emit('error', new Error('synthetic archive failure'));

    await expect(bounded.append(entryBuffer(1), { name: 'next.bin' })).rejects.toThrow(
      'synthetic archive failure'
    );
    await expect(bounded.finalize()).rejects.toThrow('synthetic archive failure');
  });

  it('rejects a nonsensical bound rather than silently running unbounded', () => {
    const archive = archiver('zip');
    archive.pipe(slowSink(0));
    expect(() => createBoundedArchive({ archive, maxPendingEntries: 0 })).toThrow(
      /positive integer/
    );
    expect(() => createBoundedArchive({ archive, maxPendingEntries: 2.5 })).toThrow(
      /positive integer/
    );
    archive.abort();
  });

  it('defaults to a bound well below the entry counts that caused the incident', () => {
    expect(MAX_PENDING_ARCHIVE_ENTRIES).toBeGreaterThan(0);
    expect(MAX_PENDING_ARCHIVE_ENTRIES).toBeLessThan(ENTRY_COUNT);
  });
});
