import { describe, expect, it } from 'vitest';
import {
  appealOrdinalText,
  filesText,
  flagScanSource,
  flagsText,
  previewCountText,
  ratingText,
  textSinceFlag,
  hashSweepText,
  PREVIEW_COUNT_CAP,
  versionsText,
} from '../model-detail';

const NOW = Date.parse('2026-10-19T12:00:00Z');

describe('previewCountText', () => {
  it('says how many are shown only when some are left out', () => {
    expect(previewCountText(12, 4)).toBe('12 preview images, 4 shown');
    expect(previewCountText(3, 3)).toBe('3 preview images');
    expect(previewCountText(1, 1)).toBe('1 preview image');
  });

  it('reads a count that hit its bound as "100+"', () => {
    expect(previewCountText(PREVIEW_COUNT_CAP + 1, 4)).toBe('100+ preview images, 4 shown');
  });
});

describe('appealOrdinalText', () => {
  it('counts this appeal among the uploader appeals this year', () => {
    expect(appealOrdinalText(1)).toBeNull();
    expect(appealOrdinalText(2)).toBe('2nd appeal by this uploader this year');
    expect(appealOrdinalText(3)).toBe('3rd appeal by this uploader this year');
    expect(appealOrdinalText(11)).toBe('11th appeal by this uploader this year');
    expect(appealOrdinalText(22)).toBe('22nd appeal by this uploader this year');
  });
});

describe('versionsText', () => {
  it('names the latest publish, or says none is published', () => {
    expect(versionsText(3, '2026-10-17T10:00:00Z', NOW)).toBe('3, latest published 2 d ago');
    expect(versionsText(1, null, NOW)).toBe('1, none published');
  });
});

describe('ratingText', () => {
  it('labels the level and says when it is locked', () => {
    expect(ratingText(4, true)).toBe('R, locked');
    expect(ratingText(2, false)).toBe('PG-13');
  });
});

describe('filesText', () => {
  it('names the main file, its size and its scans', () => {
    expect(filesText({ name: 'a.safetensors', sizeKB: 2048, scansOk: true, otherFiles: 0 })).toBe(
      'a.safetensors, 2.0 MB, scans ok'
    );
    expect(filesText({ name: 'a.safetensors', sizeKB: 2048, scansOk: false, otherFiles: 2 })).toBe(
      'a.safetensors, 2.0 MB, scans not clean · +2 more files'
    );
    expect(filesText(null)).toBe('none');
  });
});

describe('flagsText', () => {
  it('counts the reverted flags on other models and the active strikes', () => {
    expect(flagsText({ count: 1, lastAt: '2025-09-04T00:00:00Z' }, 0)).toBe(
      '1 flag reverted on another model, 2025-09 · 0 strikes'
    );
    expect(flagsText({ count: 0, lastAt: null }, 2)).toBe('none reverted · 2 strikes');
    // An unreadable count must not read as a clean record.
    expect(flagsText({ count: 0, lastAt: null }, null)).toBe('none reverted · strikes unavailable');
  });
});

const row = (
  workflowId: string | null,
  textHash: string | null,
  status = 'Succeeded',
  at = '2026-10-10T00:00:00Z'
) => ({ workflowId, textHash, status, updatedAt: at });

describe('flagScanSource', () => {
  it('names the scan row whose workflow raised the flag', () => {
    const rows = { main: row('wf-a', 'h'), search: row('wf-b', 'h') };
    expect(flagScanSource('wf-b', rows)).toBe('web search');
    expect(flagScanSource('wf-a', rows)).toBe('main');
  });
  it('says nothing once both rows have been rescanned since', () => {
    expect(flagScanSource('wf-old', { main: row('wf-a', 'h'), search: null })).toBeNull();
    expect(flagScanSource(undefined, { main: row('wf-a', 'h'), search: null })).toBeNull();
    expect(flagScanSource('wf-a', null)).toBeNull();
  });
});

describe('textSinceFlag', () => {
  it('compares the newest scanned text with the flagged text', () => {
    const rows = {
      main: row('a', 'old', 'Succeeded', '2026-10-01T00:00:00Z'),
      search: row('b', 'new', 'Succeeded', '2026-10-05T00:00:00Z'),
    };
    expect(textSinceFlag('new', rows)).toBe('unchanged');
    expect(textSinceFlag('old', rows)).toBe('changed');
  });
  it('makes no claim while a rescan is pending or nothing was hashed', () => {
    expect(textSinceFlag('h', { main: row('a', 'h', 'Pending'), search: null })).toBeNull();
    expect(textSinceFlag('h', { main: row('a', null), search: null })).toBeNull();
    expect(textSinceFlag(null, { main: row('a', 'h'), search: null })).toBeNull();
    expect(textSinceFlag('h', null)).toBeNull();
  });
});

describe('hashSweepText', () => {
  it('names the sweep, its age and what is left of the review window', () => {
    expect(hashSweepText('2026-10-16T12:00:00Z', 27, NOW)).toBe(
      'hash sweep, 3 d ago · 27 days left, then the flag is presumed correct'
    );
    expect(hashSweepText('2026-10-16T12:00:00Z', 1, NOW)).toBe(
      'hash sweep, 3 d ago · 1 day left, then the flag is presumed correct'
    );
    expect(hashSweepText('2026-09-01T12:00:00Z', 0, NOW)).toBe(
      'hash sweep, 48 d ago · review window closed; the flag is presumed correct'
    );
  });
  it('leaves out what it does not know', () => {
    expect(hashSweepText('2026-10-16T12:00:00Z', null, NOW)).toBe('hash sweep, 3 d ago');
    expect(hashSweepText(null, null, NOW)).toBe('hash sweep');
  });
});
