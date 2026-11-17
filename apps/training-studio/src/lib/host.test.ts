import { describe, expect, it } from 'vitest';
import { autoLabelAvailable, setHostContext, type HostContext } from './host';

const withConfig = (config: Partial<HostContext['config']>) =>
  setHostContext({
    backend: {} as HostContext['backend'],
    config: { imageLocation: null, signalsEndpoint: null, ...config },
    hrefFor: () => '/',
    navigate: async () => {},
    refresh: async () => {},
  });

describe('autoLabelAvailable', () => {
  it('is off where the host says it cannot auto-label (the standalone shell)', () => {
    withConfig({ canAutoLabel: false, autoLabelUrl: 'https://civitai.com/models/train' });
    expect(autoLabelAvailable()).toBe(false);
  });

  it('is on when the host does not say otherwise, or says it can', () => {
    withConfig({});
    expect(autoLabelAvailable()).toBe(true);
    withConfig({ canAutoLabel: true });
    expect(autoLabelAvailable()).toBe(true);
  });
});
