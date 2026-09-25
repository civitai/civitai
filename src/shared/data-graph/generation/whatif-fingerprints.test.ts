import { describe, expect, it } from 'vitest';
import { applyWhatIfFingerprints } from './whatif-fingerprints';

const controlVideo = {
  preprocessor: 'canny',
  mode: 'auto' as const,
  video: {
    url: 'https://x/control.mp4',
    metadata: { fps: 24, width: 1280, height: 720, duration: 6 },
  },
  strength: 1,
  startPercent: 0,
  endPercent: 1,
};

// Every field left in the projection re-fires a whatIf request when it changes.
// A revert reads as two projections that should be equal comparing unequal.
describe('controlVideo whatIf fingerprint', () => {
  it('ignores strength and the active range', () => {
    const a = applyWhatIfFingerprints({ controlVideo });
    const b = applyWhatIfFingerprints({
      controlVideo: { ...controlVideo, strength: 0.2, startPercent: 0.3, endPercent: 0.6 },
    });

    expect(a).toEqual(b);
  });

  it('ignores video metadata, which arrives asynchronously after upload', () => {
    const a = applyWhatIfFingerprints({ controlVideo });
    const b = applyWhatIfFingerprints({
      controlVideo: { ...controlVideo, video: { url: controlVideo.video.url } },
    });

    expect(a).toEqual(b);
  });

  it('reacts to the video and the preprocessor, which do change cost', () => {
    const base = applyWhatIfFingerprints({ controlVideo });

    expect(
      applyWhatIfFingerprints({
        controlVideo: { ...controlVideo, video: { url: 'https://x/other.mp4' } },
      })
    ).not.toEqual(base);
    expect(
      applyWhatIfFingerprints({ controlVideo: { ...controlVideo, preprocessor: 'dwpose' } })
    ).not.toEqual(base);
  });

  it('distinguishes an attached control video from none', () => {
    expect(applyWhatIfFingerprints({ controlVideo })).not.toEqual(
      applyWhatIfFingerprints({ controlVideo: undefined })
    );
  });
});

describe('YuE2 score pricing', () => {
  it('refetches when a supplied score replaces paid planning, not on every note edit', () => {
    const absent = applyWhatIfFingerprints({ yue2Mode: 'full', yue2Abc: '' });
    const supplied = applyWhatIfFingerprints({ yue2Mode: 'full', yue2Abc: 'X:1\nK:C\nC D E G |' });
    expect(supplied).not.toEqual(absent);
    expect(applyWhatIfFingerprints({ yue2Mode: 'full', yue2Abc: 'X:1\nK:G\nG A B d |' })).toEqual(
      supplied
    );
    expect(applyWhatIfFingerprints({ yue2Mode: 'full', yue2Abc: '   ' })).toEqual(absent);
    expect(applyWhatIfFingerprints({ yue2Mode: 'off', yue2Abc: '' })).not.toEqual(absent);
  });
});

describe('partially hydrated resources', () => {
  // These run over the raw node value, where the input schema still allows a bare `{ id }`. A throw
  // reaches an unisolated watcher loop and freezes the quoted cost on the previous selection, so the
  // projection has to survive a resource whose model has not been filled in yet.
  it('fingerprints a resource that has no model yet', () => {
    expect(() => applyWhatIfFingerprints({ resources: [{ id: 7 }] })).not.toThrow();
  });

  it('still distinguishes one id from another while unhydrated', () => {
    expect(applyWhatIfFingerprints({ resources: [{ id: 7 }] })).not.toEqual(
      applyWhatIfFingerprints({ resources: [{ id: 8 }] })
    );
  });

  it('refetches once the type arrives', () => {
    expect(applyWhatIfFingerprints({ resources: [{ id: 7 }] })).not.toEqual(
      applyWhatIfFingerprints({ resources: [{ id: 7, model: { type: 'Checkpoint' } }] })
    );
  });
});
