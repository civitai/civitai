import { describe, expect, it } from 'vitest';
import {
  faceScanAllows,
  parseFaceAnimeMin,
  readSearchUploadScan,
  searchUploadVerdict,
  type SearchUploadScan,
} from '~/server/services/search-upload-gate';

const MIN = 0.5;
const scan = (ran: boolean, ...anime: (number | null)[]) => ({
  ran,
  faces: anime.map((animeProbability) => ({ animeProbability })),
});

describe('the face rule', () => {
  it.each([
    ['allows an image where the detector ran and found no one', scan(true), true],
    ['allows a face scored at the minimum', scan(true, MIN), true],
    ['allows several faces all at or above the minimum', scan(true, 0.99, MIN), true],
    ['refuses a face just below the minimum', scan(true, MIN - 0.01), false],
    ['refuses when any one face is below the minimum', scan(true, 0.99, 0.1), false],
    ['refuses a face with no score', scan(true, null), false],
    ['refuses when the detector did not run, even with no faces', scan(false), false],
    ['refuses when there is no scan record', undefined, false],
    ['refuses a record without a faces list', { ran: true }, false],
    ['refuses a record whose ran is not true', { ran: 'true', faces: [] }, false],
  ])('%s', (_name, record, expected) => {
    expect(faceScanAllows(record, MIN)).toBe(expected);
  });

  it('refuses a face with no score even when the minimum is 0', () => {
    expect(faceScanAllows(scan(true, null), 0)).toBe(false);
    expect(faceScanAllows(scan(true, 0), 0)).toBe(true);
  });

  it('refuses any face when no minimum is configured, but still allows no faces', () => {
    expect(faceScanAllows(scan(true, 1), undefined)).toBe(false);
    expect(faceScanAllows(scan(true), undefined)).toBe(true);
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['abc', undefined],
    ['1.5', undefined],
    ['-0.1', undefined],
    ['0.5', 0.5],
    ['0.9', 0.9],
    [' 1 ', 1],
  ])('reads the setting %j as %j', (raw, expected) => {
    expect(parseFaceAnimeMin(raw)).toBe(expected);
  });
});

describe('reading the scan workflow', () => {
  const output = (over: Record<string, unknown> = {}) => ({
    nsfwLevel: 'pg',
    blockedReason: null,
    jointAgeClassification: {
      ran: true,
      minorDetected: false,
      childDetected: false,
      detections: [{ animeProbability: 0.3 }, { animeProbability: Number.NaN }],
    },
    ...over,
  });
  const succeeded = (out: unknown) => ({
    status: 'succeeded',
    steps: [{ $type: 'imageScanning', output: out }],
  });

  it.each(['unassigned', 'preparing', 'scheduled', 'processing', undefined])(
    'is pending while the workflow is %s',
    (status) => {
      expect(readSearchUploadScan({ status, steps: [] })).toEqual({ state: 'pending' });
    }
  );

  it.each(['failed', 'expired', 'canceled'])('is failed when the workflow %s', (status) => {
    expect(readSearchUploadScan({ status, steps: [] })).toEqual({ state: 'failed' });
  });

  it('reads the level, the flags and each face, a missing score as null', () => {
    expect(readSearchUploadScan(succeeded(output()))).toEqual({
      state: 'done',
      completedAt: null,
      nsfwLevel: 1,
      blocked: false,
      minorDetected: false,
      childDetected: false,
      faceScan: { ran: true, faces: [{ animeProbability: 0.3 }, { animeProbability: null }] },
    });
  });

  it.each<[string, unknown]>([
    ['no scan step', undefined],
    ['no age classification', output({ jointAgeClassification: undefined })],
    ['a level it cannot map', output({ nsfwLevel: 'na' })],
  ])('is failed on a succeeded workflow with %s', (_name, out) => {
    expect(readSearchUploadScan(succeeded(out))).toEqual({ state: 'failed' });
  });

  it('is failed when the age classifier did not run, so moderators are refused too', () => {
    const age = { ...output().jointAgeClassification, ran: false };
    expect(readSearchUploadScan(succeeded(output({ jointAgeClassification: age })))).toEqual({
      state: 'failed',
    });
  });

  it('reads a block reason, a CSAM signal and the minor and child flags', () => {
    const read = (over: Record<string, unknown>) =>
      readSearchUploadScan(succeeded(output(over))) as Extract<SearchUploadScan, { state: 'done' }>;
    expect(read({ blockedReason: 'refused' }).blocked).toBe(true);
    expect(read({ csam: true }).blocked).toBe(true);
    const age = output().jointAgeClassification;
    expect(read({ jointAgeClassification: { ...age, minorDetected: true } }).minorDetected).toBe(
      true
    );
    expect(read({ jointAgeClassification: { ...age, childDetected: true } }).childDetected).toBe(
      true
    );
  });
});

describe('the upload verdict', () => {
  const done = (over: Partial<Extract<SearchUploadScan, { state: 'done' }>> = {}) =>
    ({
      state: 'done',
      nsfwLevel: 1,
      blocked: false,
      minorDetected: false,
      childDetected: false,
      faceScan: scan(true),
      ...over,
    } as SearchUploadScan);
  const clean = { verdict: 'rated' as const, blockedReason: null };
  const user = { isModerator: false, faceAnimeMin: MIN, timedOut: false };
  const mod = { isModerator: true, faceAnimeMin: MIN, timedOut: false };
  const verdict = (...args: Parameters<typeof searchUploadVerdict>) =>
    searchUploadVerdict(...args).verdict;

  it('passes a clean scan with no faces', () => {
    expect(verdict(done(), clean, user)).toBe('ready');
  });

  it('waits on the scan, then refuses once it has timed out', () => {
    expect(verdict({ state: 'pending' }, clean, user)).toBe('pending');
    expect(searchUploadVerdict({ state: 'pending' }, clean, { ...mod, timedOut: true })).toEqual({
      verdict: 'refused',
      reason: 'timed-out',
    });
  });

  it('waits on the blob verdict, then refuses once it has timed out', () => {
    expect(verdict(done(), { verdict: 'pending' }, user)).toBe('pending');
    expect(verdict(done(), { verdict: 'pending' }, { ...mod, timedOut: true })).toBe('refused');
  });

  it.each<[string, SearchUploadScan, string]>([
    ['a failed scan', { state: 'failed' }, 'scan-failed'],
    ['a blocked scan', done({ blocked: true }), 'blocked'],
    ['a minor flag', done({ minorDetected: true }), 'minor'],
    ['a child flag', done({ childDetected: true }), 'minor'],
  ])('refuses %s, for a moderator too', (_name, s, reason) => {
    expect(searchUploadVerdict(s, clean, user)).toEqual({ verdict: 'refused', reason });
    expect(searchUploadVerdict(s, clean, mod)).toEqual({ verdict: 'refused', reason });
  });

  it('refuses when the orchestrator refused the blob, for a moderator too', () => {
    const blocked = { verdict: 'rated' as const, blockedReason: 'refused' };
    expect(verdict(done(), blocked, user)).toBe('refused');
    expect(verdict(done(), blocked, mod)).toBe('refused');
  });

  it('refuses a non-moderator a photo face, and passes a moderator', () => {
    const photo = done({ faceScan: scan(true, 0.02) });
    expect(searchUploadVerdict(photo, clean, user)).toEqual({
      verdict: 'refused',
      reason: 'faces',
    });
    expect(verdict(photo, clean, mod)).toBe('ready');
  });

  it('passes a non-moderator a face at the minimum', () => {
    expect(verdict(done({ faceScan: scan(true, MIN) }), clean, user)).toBe('ready');
  });

  it('refuses a non-moderator when the age classifier did not run, and passes a moderator', () => {
    expect(verdict(done({ faceScan: scan(false) }), clean, user)).toBe('refused');
    expect(verdict(done({ faceScan: scan(false) }), clean, mod)).toBe('ready');
  });
});
