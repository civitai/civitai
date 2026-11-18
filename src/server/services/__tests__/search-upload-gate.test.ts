import { describe, expect, it } from 'vitest';
import {
  faceScanAllows,
  parseFaceAnimeMin,
  searchUploadVerdict,
  toSearchUploadFaceScan,
  type SearchUploadRow,
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

  it('records each detected person, and a missing score as null', () => {
    expect(
      toSearchUploadFaceScan({
        ageClassificationRan: true,
        ageDetections: [{ animeProbability: 0.3 }, { animeProbability: Number.NaN }],
      })
    ).toEqual({ ran: true, faces: [{ animeProbability: 0.3 }, { animeProbability: null }] });
  });
});

describe('the upload verdict', () => {
  const passed: SearchUploadRow = {
    ingestion: 'Scanned',
    tosViolation: false,
    blockedFor: null,
    needsReview: null,
    minor: false,
    poi: false,
    metadata: { searchUploadFaceScan: scan(true) },
  };
  const clean = { verdict: 'rated' as const, blockedReason: null };
  const user = { isModerator: false, faceAnimeMin: MIN };
  const mod = { isModerator: true, faceAnimeMin: MIN };

  it('passes a clean, scanned upload with no faces', () => {
    expect(searchUploadVerdict(passed, clean, user)).toBe('ready');
  });

  it.each(['Pending', 'Rescan'])('waits while ingestion is %s', (ingestion) => {
    expect(searchUploadVerdict({ ...passed, ingestion }, clean, user)).toBe('pending');
  });

  it('waits while the blob verdict is pending', () => {
    expect(searchUploadVerdict(passed, { verdict: 'pending' }, user)).toBe('pending');
  });

  it.each<[string, Partial<SearchUploadRow>]>([
    ['blocked ingestion', { ingestion: 'Blocked' }],
    ['a scan error', { ingestion: 'Error' }],
    ['a ToS violation', { tosViolation: true }],
    ['a block reason', { blockedFor: 'Moderated' }],
    ['a review hold', { needsReview: 'poi' }],
    ['a minor flag', { minor: true }],
    ['a POI flag', { poi: true }],
  ])('refuses %s, for a moderator too', (_name, over) => {
    expect(searchUploadVerdict({ ...passed, ...over }, clean, user)).toBe('refused');
    expect(searchUploadVerdict({ ...passed, ...over }, clean, mod)).toBe('refused');
  });

  it('refuses when the orchestrator refused the blob, for a moderator too', () => {
    const blocked = { verdict: 'rated' as const, blockedReason: 'refused' };
    expect(searchUploadVerdict(passed, blocked, user)).toBe('refused');
    expect(searchUploadVerdict(passed, blocked, mod)).toBe('refused');
  });

  it('refuses a non-moderator a photo face, and passes a moderator', () => {
    const photo = { ...passed, metadata: { searchUploadFaceScan: scan(true, 0.02) } };
    expect(searchUploadVerdict(photo, clean, user)).toBe('refused');
    expect(searchUploadVerdict(photo, clean, mod)).toBe('ready');
  });

  it('passes a non-moderator a face at the minimum', () => {
    const anime = { ...passed, metadata: { searchUploadFaceScan: scan(true, MIN) } };
    expect(searchUploadVerdict(anime, clean, user)).toBe('ready');
  });

  it('refuses a non-moderator when the scan wrote no face record', () => {
    expect(searchUploadVerdict({ ...passed, metadata: {} }, clean, user)).toBe('refused');
    expect(searchUploadVerdict({ ...passed, metadata: null }, clean, user)).toBe('refused');
    expect(searchUploadVerdict({ ...passed, metadata: null }, clean, mod)).toBe('ready');
  });
});
