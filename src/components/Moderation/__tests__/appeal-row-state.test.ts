import { describe, expect, it } from 'vitest';
import { appealRowState } from '~/components/Moderation/appeal-row-state';

const verdict = { at: 'x', workflowId: 'wf-1', reason: 'r', textHash: 'h' };
const row = (over: Record<string, unknown> = {}) => ({
  minor: false,
  poi: false,
  flagSource: null as string | null,
  flagConfirmedFrom: null as string | null,
  textScanFlags: null as Record<string, unknown> | null,
  ...over,
});

describe('appealRowState', () => {
  it('shows the hash-match panel only for a hash-origin or moderator minor snapshot', () => {
    expect(appealRowState(row({ minor: true, flagSource: 'auto' })).showHashMatch).toBe(true);
    expect(appealRowState(row({ minor: true, flagSource: 'manual' })).showHashMatch).toBe(true);
    expect(appealRowState(row({ minor: true, flagSource: 'text-scan' })).showHashMatch).toBe(false);
    expect(
      appealRowState(row({ minor: true, flagSource: 'manual', flagConfirmedFrom: 'text-scan' })).showHashMatch
    ).toBe(false);
    expect(appealRowState(row({ poi: true, textScanFlags: { poi: verdict } })).showHashMatch).toBe(false);
  });

  it('offers a split decision only while both labels are open', () => {
    const both = row({ minor: true, poi: true, flagSource: 'text-scan', textScanFlags: { poi: verdict, minor: verdict } });
    expect(appealRowState(both).bothFlagged).toBe(true);
    const granted = row({
      minor: true,
      poi: true,
      textScanFlags: { poi: { ...verdict, appealGranted: { at: 'x', by: 1, textHash: 'h' } } },
    });
    expect(appealRowState(granted).bothFlagged).toBe(false);
  });

  it('lists verdicts, not ruling stubs, and labels the source from them', () => {
    const stubbed = row({
      minor: true,
      flagSource: 'auto',
      textScanFlags: { minor: { appealGranted: { at: 'x', by: 1, textHash: 'h', via: 'moderator' } } },
    });
    expect(appealRowState(stubbed).verdictLabels).toEqual([]);
    expect(appealRowState(stubbed).sourceLabel).toBe('Auto');
    expect(appealRowState(row({ poi: true, textScanFlags: { poi: verdict } })).sourceLabel).toBe('Text scan');
    expect(appealRowState(row()).sourceLabel).toBe('Reverted');
  });
});
