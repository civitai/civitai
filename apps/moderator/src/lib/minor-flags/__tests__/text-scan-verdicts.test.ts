import { describe, expect, it } from 'vitest';
import { openVerdicts } from '../text-scan-verdicts';

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
