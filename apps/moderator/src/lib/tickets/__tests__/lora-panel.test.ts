import { describe, expect, it } from 'vitest';
import { loraPanelFor } from '../lora-panel';
import { generatorPanelFor } from '../generator-panel';

const ticket = {
  view: 'support' as const,
  cfFeature: 'LoRA Trainer' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

describe('loraPanelFor', () => {
  it('shows on a support ticket about the LoRA trainer', () => {
    expect(loraPanelFor(ticket)).toBe('panel');
    expect(loraPanelFor({ ...ticket, cfFeature: '  LoRA Trainer ' })).toBe('panel');
  });

  it('says only that no user is linked when there is none', () => {
    expect(loraPanelFor({ ...ticket, civitaiUserId: null })).toBe('unlinked');
  });

  it('is hidden on the moderation view and on other features', () => {
    expect(loraPanelFor({ ...ticket, view: 'moderation' })).toBe('hidden');
    expect(loraPanelFor({ ...ticket, cfFeature: 'Image Generator' })).toBe('hidden');
    expect(loraPanelFor({ ...ticket, cfFeature: null })).toBe('hidden');
  });

  it('leaves the image generator tickets to the generator panel', () => {
    const gen = { ...ticket, cfFeature: 'Image Generator' };
    expect(generatorPanelFor(ticket)).toBe('hidden');
    expect(generatorPanelFor(gen)).toBe('panel');
  });
});
