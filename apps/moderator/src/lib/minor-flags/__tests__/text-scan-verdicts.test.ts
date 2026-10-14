import { describe, expect, it } from 'vitest';
import { flagInForce, latestScanDisagrees, openVerdicts, poiInForce } from '../text-scan-verdicts';

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
  it('is false with no flag', () => {
    expect(flagInForce({ minor: false, poi: false, textScanFlags: open })).toBe(false);
  });
});

describe('latestScanDisagrees', () => {
  const scan = {
    entityType: 'Model:search',
    status: 'Succeeded',
    updatedAt: '2026-10-02T00:00:00Z',
    poi: { detected: false, reason: 'No real person named.' },
    minor: { detected: true, reason: 'Says 15.' },
  };

  it('is true only when the latest scan no longer detects the flagged label', () => {
    expect(latestScanDisagrees(scan, 'poi')).toBe(true);
    expect(latestScanDisagrees(scan, 'minor')).toBe(false);
  });

  it('is false when the scan has no verdict for the label, or there is no scan', () => {
    expect(latestScanDisagrees({ ...scan, poi: null }, 'poi')).toBe(false);
    expect(latestScanDisagrees({ ...scan, poi: { detected: null, reason: null } }, 'poi')).toBe(
      false
    );
    expect(latestScanDisagrees(null, 'poi')).toBe(false);
  });
});
