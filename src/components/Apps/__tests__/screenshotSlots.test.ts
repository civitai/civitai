import { describe, expect, it } from 'vitest';
import {
  appendScreenshotSlot,
  makeScreenshotSlotId,
  patchScreenshotSlot,
  type ScreenshotSlot,
} from '~/components/Apps/screenshotSlots';

/**
 * W13 P3a — pure slot-management for the off-site submit screenshot batch.
 *
 * Deterministic coverage of the highest-risk change of the audit-fix commit: the
 * multi-file batch must give every file its OWN slot (no index/closure collision),
 * and every per-file update (attach result, error, retry) must patch THAT slot BY
 * ITS STABLE ID — never a sibling. Mirrors the sequence
 * `ExternalSubmitForm.handleScreenshots` / `retryScreenshot` drive.
 */
describe('screenshotSlots — multi-file batch slot management', () => {
  it('makeScreenshotSlotId yields a distinct stable id per sequence number', () => {
    const ids = [0, 1, 2].map(makeScreenshotSlotId);
    expect(ids).toEqual(['ss_0', 'ss_1', 'ss_2']);
    expect(new Set(ids).size).toBe(3);
  });

  it('appends three DISTINCT slots for a 3-file batch (no collision / overwrite)', () => {
    // Mirror handleScreenshots: a shared monotonic counter hands each file its own
    // stable id, appended one at a time (the loop appends before awaiting upload).
    let seq = 0;
    let slots: ScreenshotSlot[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = makeScreenshotSlotId(seq++);
      ids.push(id);
      slots = appendScreenshotSlot(slots, id);
    }
    expect(slots).toHaveLength(3);
    expect(slots.map((s: ScreenshotSlot) => s.id)).toEqual(ids);
    // The bug this fixes: a batch previously collided onto ONE slot. Assert distinct.
    expect(new Set(slots.map((s: ScreenshotSlot) => s.id)).size).toBe(3);
    expect(slots.every((s: ScreenshotSlot) => s.status === 'working')).toBe(true);
  });

  it('an attach result patches ONLY its own slot by id, leaving siblings untouched', () => {
    let slots: ScreenshotSlot[] = [];
    for (let i = 0; i < 3; i++) slots = appendScreenshotSlot(slots, makeScreenshotSlotId(i));
    // The MIDDLE file's attach lands — only ss_1 moves to 'attached'.
    slots = patchScreenshotSlot(slots, 'ss_1', { status: 'attached', imageId: 42, message: null });
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_1')).toMatchObject({
      status: 'attached',
      imageId: 42,
    });
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_0')?.status).toBe('working');
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_2')?.status).toBe('working');
    // Every slot keeps its own stable id through the patch.
    expect(slots.map((s: ScreenshotSlot) => s.id)).toEqual(['ss_0', 'ss_1', 'ss_2']);
  });

  it('Retry patches THAT slot by its stable id (processing → working → attached), never a sibling', () => {
    let slots: ScreenshotSlot[] = [
      { id: 'ss_0', status: 'attached', imageId: 1, message: null },
      { id: 'ss_1', status: 'processing', imageId: 2, message: 'still scanning' },
    ];
    // Retry ss_1: flip to working, then land the re-attach result — ss_0 never moves.
    slots = patchScreenshotSlot(slots, 'ss_1', { status: 'working' });
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_1')?.status).toBe('working');
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_0')?.status).toBe('attached');
    slots = patchScreenshotSlot(slots, 'ss_1', { status: 'attached', imageId: 2, message: null });
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_1')).toMatchObject({
      status: 'attached',
      imageId: 2,
      message: null,
    });
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_0')).toMatchObject({
      status: 'attached',
      imageId: 1,
    });
  });

  it('an error on one file patches only that slot (id preserved), not the batch', () => {
    let slots: ScreenshotSlot[] = [];
    for (let i = 0; i < 3; i++) slots = appendScreenshotSlot(slots, makeScreenshotSlotId(i));
    slots = patchScreenshotSlot(slots, 'ss_2', {
      status: 'error',
      imageId: null,
      message: 'upload failed',
    });
    expect(slots.find((s: ScreenshotSlot) => s.id === 'ss_2')).toMatchObject({
      id: 'ss_2',
      status: 'error',
      message: 'upload failed',
    });
    expect(slots.filter((s: ScreenshotSlot) => s.status === 'working').map((s) => s.id)).toEqual([
      'ss_0',
      'ss_1',
    ]);
  });

  it('patchScreenshotSlot is a no-op (structurally equal) when the id is absent', () => {
    const slots: ScreenshotSlot[] = [
      { id: 'ss_0', status: 'working', imageId: null, message: null },
    ];
    const next = patchScreenshotSlot(slots, 'ss_missing', { status: 'error', message: 'x' });
    expect(next).toEqual(slots);
  });

  it('append and patch never mutate the input array (referential immutability)', () => {
    const original: ScreenshotSlot[] = [
      { id: 'ss_0', status: 'working', imageId: null, message: null },
    ];
    const appended = appendScreenshotSlot(original, 'ss_1');
    expect(original).toHaveLength(1);
    expect(appended).not.toBe(original);
    const patched = patchScreenshotSlot(appended, 'ss_0', { status: 'attached', imageId: 5 });
    expect(appended.find((s: ScreenshotSlot) => s.id === 'ss_0')?.status).toBe('working');
    expect(patched).not.toBe(appended);
  });
});
