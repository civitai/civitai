import { describe, expect, it } from 'vitest';
import {
  flagInForce,
  latestScanDisagrees,
  openVerdicts,
  poiInForce,
  detectionCopy,
  detectionKind,
  detectionSections,
  rulingText,
  scanVerdictProvenance,
  scanVerdictText,
} from '../text-scan-verdicts';

const verdict = { at: 'x', workflowId: 'wf-1', reason: 'Names a real actor.', names: ['Jane'] };
const granted = { ...verdict, appealGranted: { at: 'x', by: 1, textHash: 'h', via: 'appeal' } };

describe('openVerdicts', () => {
  it('drops a verdict an appeal already lifted', () => {
    expect(openVerdicts({ minor: granted, poi: verdict })).toEqual([
      { label: 'poi', flag: verdict },
    ]);
  });

  it('drops a ruling stub, which has no workflow', () => {
    expect(openVerdicts({ minor: { appealGranted: granted.appealGranted } })).toEqual([]);
  });

  it('lists both open verdicts in label order', () => {
    expect(openVerdicts({ poi: verdict, minor: verdict }).map((v) => v.label)).toEqual([
      'minor',
      'poi',
    ]);
  });

  it('reads nothing from a missing or malformed column', () => {
    expect(openVerdicts(null)).toEqual([]);
    expect(openVerdicts('x')).toEqual([]);
  });
});

describe('flagInForce', () => {
  const open = { poi: { workflowId: 'wf' } };
  const lifted = { poi: { workflowId: 'wf', appealGranted: true } };
  it('holds for a minor flag whatever the text scan says', () => {
    expect(flagInForce({ minor: true, poi: false, textScanFlags: null })).toBe(true);
  });
  it('holds for a real-person flag only while its verdict is open', () => {
    expect(poiInForce({ minor: false, poi: true, textScanFlags: open })).toBe(true);
    expect(flagInForce({ minor: false, poi: true, textScanFlags: lifted })).toBe(false);
    expect(flagInForce({ minor: false, poi: true, textScanFlags: null })).toBe(false);
  });
  it('holds for a hash-applied real-person flag with no verdict, as the appeal resolver does', () => {
    expect(poiInForce({ minor: false, poi: true, textScanFlags: null, poiHashFlag: true })).toBe(
      true
    );
    expect(poiInForce({ minor: false, poi: false, textScanFlags: null, poiHashFlag: true })).toBe(
      false
    );
  });
  it('is false with no flag', () => {
    expect(flagInForce({ minor: false, poi: false, textScanFlags: open })).toBe(false);
  });
});

describe('latestScanDisagrees', () => {
  const at = {
    source: 'web search' as const,
    status: 'Succeeded',
    updatedAt: '2026-10-02T00:00:00Z',
  };
  const scan = {
    poi: { detected: false, reason: 'No real person named.', ...at },
    minor: { detected: true, reason: 'Says 15.', ...at },
  };

  it('is true only when the latest scan no longer detects the flagged label', () => {
    expect(latestScanDisagrees(scan, 'poi')).toBe(true);
    expect(latestScanDisagrees(scan, 'minor')).toBe(false);
  });

  it('is false when the scan has no verdict for the label, or there is no scan', () => {
    expect(latestScanDisagrees({ ...scan, poi: null }, 'poi')).toBe(false);
    expect(latestScanDisagrees({ ...scan, poi: { ...scan.poi, detected: null } }, 'poi')).toBe(
      false
    );
    expect(latestScanDisagrees(null, 'poi')).toBe(false);
  });
});

describe('scanVerdictProvenance', () => {
  const label = { detected: true, reason: 'r', updatedAt: '2026-10-02T00:00:00Z' };

  it('names the source and leaves the date to the caller for a finished scan', () => {
    expect(scanVerdictProvenance({ ...label, source: 'main', status: 'Succeeded' })).toEqual({
      source: 'main scan',
      note: null,
    });
  });

  it('says a rescan is pending or failed instead of dating the last verdict', () => {
    expect(scanVerdictProvenance({ ...label, source: 'web search', status: 'Pending' })).toEqual({
      source: 'web search',
      note: 'rescan pending — last verdict shown',
    });
    for (const status of ['Failed', 'Expired', 'Canceled'])
      expect(scanVerdictProvenance({ ...label, source: 'main', status }).note).toBe(
        'last rescan failed — last verdict shown'
      );
  });
});

describe('scanVerdictText', () => {
  it('joins the verdict and its reason', () => {
    expect(scanVerdictText({ detected: true, reason: 'Says 15.' })).toBe('detected — Says 15.');
    expect(scanVerdictText({ detected: false, reason: null })).toBe('not detected');
    expect(scanVerdictText({ detected: null, reason: 'Odd.' })).toBe('no verdict — Odd.');
  });
});

describe('rulingText', () => {
  it.each([
    ['appealGranted', 'moderator', 'Cleared (moderator unflagged)'],
    ['appealGranted', 'appeal', 'Cleared (appeal overturned)'],
    ['appealUpheld', 'moderator', 'Kept flagged (kept by moderator)'],
    ['appealUpheld', 'appeal', 'Kept flagged (upheld on appeal)'],
    ['appealUpheld', undefined, 'Kept flagged'],
    ['somethingNew', 'moderator', 'somethingNew'],
  ])('%s via %s reads %s', (decision, via, text) => {
    expect(rulingText(decision, via)).toBe(text);
  });
});

describe('detectionKind', () => {
  it('reads a marker with no kind as a re-detection', () => {
    expect(detectionKind({})).toBe('redetected');
    expect(detectionKind({ kind: 'redetected' })).toBe('redetected');
    expect(detectionKind({ kind: 'first' })).toBe('first');
  });

  it('treats an unrecognised kind as a re-detection', () => {
    expect(detectionKind({ kind: 'later' as never })).toBe('redetected');
  });
});

describe('detectionCopy', () => {
  it('does not claim a prior clear for a first detection', () => {
    const copy = detectionCopy('first');
    expect(copy.provenance).toBe('first detection');
    expect(copy.showsPriorClear).toBe(false);
  });

  it('describes a re-detection as text found after a human clear', () => {
    const copy = detectionCopy('redetected');
    expect(copy.provenance).toBe('re-detection after a clear');
    expect(copy.showsPriorClear).toBe(true);
  });
});

describe('detectionSections', () => {
  const ruling = { decision: 'appealUpheld' };

  it('shows earlier rulings on a first detection that carries them, without a prior clear', () => {
    expect(detectionSections('first', [ruling])).toEqual({ priorClear: false, rulings: true });
  });

  it('shows nothing prior on a first detection with no rulings', () => {
    expect(detectionSections('first', null)).toEqual({ priorClear: false, rulings: false });
    expect(detectionSections('first', [])).toEqual({ priorClear: false, rulings: false });
  });

  it('shows the prior clear on a re-detection, and its rulings when present', () => {
    expect(detectionSections('redetected', [ruling])).toEqual({ priorClear: true, rulings: true });
    expect(detectionSections('redetected', undefined)).toEqual({
      priorClear: true,
      rulings: false,
    });
  });
});
