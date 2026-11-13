import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ExclusivePlayback from '~/components/Audio/exclusive-playback';

type FakeMedia = { paused: boolean; isConnected: boolean; pause: ReturnType<typeof vi.fn> };

const media = (paused = false): FakeMedia => ({
  paused,
  isConnected: true,
  pause: vi.fn(function (this: FakeMedia) {
    this.paused = true;
  }),
});
const asMedia = (m: FakeMedia) => m as unknown as HTMLMediaElement;

let claimPlayback: typeof ExclusivePlayback.claimPlayback;
beforeEach(async () => {
  // The claim lives in the module: each test starts with nothing playing.
  vi.resetModules();
  ({ claimPlayback } = await import('~/components/Audio/exclusive-playback'));
});

describe('one song player sounds at a time', () => {
  it('pauses the player that was playing before, and only that one', () => {
    const [a, b, c] = [media(), media(), media(true)];
    claimPlayback(asMedia(a));
    claimPlayback(asMedia(b));

    expect(a.pause).toHaveBeenCalledTimes(1);
    expect(b.pause).not.toHaveBeenCalled();
    expect(c.pause).not.toHaveBeenCalled();
  });

  it('leaves a player that is already paused alone', () => {
    const [a, b] = [media(), media()];
    claimPlayback(asMedia(a));
    a.paused = true;
    claimPlayback(asMedia(b));

    expect(a.pause).not.toHaveBeenCalled();
  });

  it('does nothing more when the same player claims again', () => {
    const [a, b] = [media(), media()];
    claimPlayback(asMedia(a));
    claimPlayback(asMedia(b));
    claimPlayback(asMedia(b));
    claimPlayback(asMedia(b));

    expect(a.pause).toHaveBeenCalledTimes(1);
    expect(b.pause).not.toHaveBeenCalled();
  });

  it("stops the player before through its own pause when it gave one, not the element's", () => {
    const [a, b] = [media(), media()];
    const pauseThroughStore = vi.fn();
    claimPlayback(asMedia(a), pauseThroughStore);
    claimPlayback(asMedia(b));

    expect(pauseThroughStore).toHaveBeenCalledTimes(1);
    expect(a.pause).not.toHaveBeenCalled();
  });
});
