import { describe, expect, it } from 'vitest';
import { textScanFlagNotifications } from '~/server/notifications/text-scan-flag.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

type Defs = typeof textScanFlagNotifications;
const prepare = (type: keyof Defs, details: MixedObject) =>
  (textScanFlagNotifications[type] as Defs[keyof Defs]).prepareMessage({ type, details } as never);

describe('text-scan flag notifications', () => {
  it('names the label and links the model page', () => {
    const poi = prepare('model-text-scan-flagged', {
      modelId: 7,
      modelName: 'My Model',
      label: 'poi',
    });
    expect(poi?.message).toContain('a real person');
    expect(poi?.message).toContain('request a review');
    expect(poi?.url).toBe('/models/7/my-model');

    const minor = prepare('model-text-scan-flagged', {
      modelId: 7,
      modelName: 'My Model',
      label: 'minor',
    });
    expect(minor?.message).toContain('a minor');
  });

  it('tells a bounty owner it was hidden and links the bounty', () => {
    const m = prepare('bounty-text-scan-flagged', { bountyId: 9, bountyName: 'B' });
    expect(m?.message).toContain('hidden');
    expect(m?.url).toBe('/bounties/9');
  });

  it('is registered and cannot be toggled off', () => {
    expect(notificationProcessors['model-text-scan-flagged']?.toggleable).toBe(false);
    expect(notificationProcessors['bounty-text-scan-flagged']?.toggleable).toBe(false);
  });
});
