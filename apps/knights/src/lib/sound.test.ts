import { describe, expect, it, vi } from 'vitest';
import {
  MASTER_VOLUME,
  SOUND_LEVELS,
  createSoundEngine,
  mutedKey,
  pickFormat,
  readMuted,
  writeMuted,
  type AudioLike,
} from './sound';

class FakeAudio implements AudioLike {
  volume = 1;
  currentTime = 0;
  paused = true;
  ended = false;
  preload = '';
  constructor(public src: string) {}
  play() {
    this.paused = false;
    plays.push(this);
    return Promise.resolve();
  }
}
let plays: FakeAudio[] = [];

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

function engine(overrides: Partial<Parameters<typeof createSoundEngine>[0]> = {}) {
  plays = [];
  let clock = 1000;
  const made: FakeAudio[] = [];
  const instance = createSoundEngine({
    createAudio: (src) => {
      const audio = new FakeAudio(src);
      made.push(audio);
      return audio;
    },
    format: () => 'ogg',
    storage: () => memoryStorage(),
    now: () => clock,
    ...overrides,
  });
  return { instance, made, tick: (ms: number) => (clock += ms) };
}

describe('pickFormat', () => {
  it('prefers ogg when the browser can play it', () => {
    expect(pickFormat((mime) => (mime.includes('ogg') ? 'probably' : 'maybe'))).toBe('ogg');
  });

  it('falls back to mp3 when ogg is refused', () => {
    expect(pickFormat((mime) => (mime.includes('mpeg') ? 'maybe' : ''))).toBe('mp3');
  });

  it('is null when neither plays', () => {
    expect(pickFormat(() => '')).toBeNull();
  });
});

describe('mute persistence', () => {
  it('defaults to sound on', () => {
    expect(readMuted(memoryStorage(), 7)).toBe(false);
    expect(readMuted(null, 7)).toBe(false);
  });

  it('remembers the choice per player', () => {
    const storage = memoryStorage();
    writeMuted(storage, 7, true);
    expect(readMuted(storage, 7)).toBe(true);
    expect(readMuted(storage, 8)).toBe(false);
    writeMuted(storage, 7, false);
    expect(readMuted(storage, 7)).toBe(false);
    expect(storage.map.has(mutedKey(7))).toBe(true);
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readMuted(broken, 7)).toBe(false);
    expect(() => writeMuted(broken, 7, true)).not.toThrow();
  });
});

describe('sound engine', () => {
  it('plays nothing until the first user interaction', () => {
    const { instance } = engine();
    instance.play('gold');
    expect(plays).toHaveLength(0);
    instance.unlock();
    instance.play('gold');
    expect(plays).toHaveLength(1);
    expect(plays[0].src).toBe('/sounds/gold.ogg');
  });

  it('unlocks on the first pointer or key event of an attached target', () => {
    const { instance } = engine();
    const target = new EventTarget();
    instance.attach(target);
    instance.play('bell');
    expect(plays).toHaveLength(0);
    target.dispatchEvent(new Event('keydown'));
    instance.play('bell');
    expect(plays).toHaveLength(1);
  });

  it('uses the mp3 file when ogg is unsupported', () => {
    const { instance } = engine({ format: () => 'mp3' });
    instance.unlock();
    instance.play('rankup');
    expect(plays[0].src).toBe('/sounds/rankup.mp3');
  });

  it('plays nothing without a supported format', () => {
    const { instance } = engine({ format: () => null });
    instance.unlock();
    instance.play('rankup');
    expect(plays).toHaveLength(0);
  });

  it('scales each sound by its own level and the master volume', () => {
    const { instance } = engine();
    instance.unlock();
    instance.play('press');
    expect(plays[0].volume).toBeCloseTo(SOUND_LEVELS.press * MASTER_VOLUME);
    expect(plays[0].volume).toBeLessThanOrEqual(0.2);
  });

  it('debounces press but not other sounds', () => {
    const { instance, tick } = engine();
    instance.unlock();
    instance.play('press');
    tick(10);
    instance.play('press');
    expect(plays).toHaveLength(1);
    instance.play('gold');
    instance.play('gold');
    expect(plays.filter((audio) => audio.src.includes('gold'))).toHaveLength(2);
    tick(200);
    instance.play('press');
    expect(plays.filter((audio) => audio.src.includes('press'))).toHaveLength(2);
  });

  it('lets the same sound overlap instead of cutting itself off', () => {
    const { instance } = engine();
    instance.unlock();
    instance.play('trial-correct');
    instance.play('trial-correct');
    expect(plays).toHaveLength(2);
    expect(plays[0]).not.toBe(plays[1]);
  });

  it('is silent while muted, and the choice is stored per player', () => {
    const storage = memoryStorage();
    const { instance } = engine({ storage: () => storage });
    instance.setPlayer(4);
    instance.unlock();
    instance.setMuted(true);
    instance.play('gold');
    expect(plays).toHaveLength(0);
    expect(storage.map.get(mutedKey(4))).toBe('1');

    const { instance: reloaded } = engine({ storage: () => storage });
    reloaded.setPlayer(4);
    reloaded.unlock();
    expect(reloaded.muted).toBe(true);
    reloaded.play('gold');
    expect(plays).toHaveLength(0);
    reloaded.setMuted(false);
    reloaded.play('gold');
    expect(plays).toHaveLength(1);
  });

  it('never throws when audio fails', () => {
    const rejecting = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    const { instance } = engine({
      createAudio: () => ({ ...new FakeAudio('x'), play: rejecting } as AudioLike),
    });
    instance.unlock();
    expect(() => instance.play('gold')).not.toThrow();

    const { instance: exploding } = engine({
      createAudio: () => {
        throw new Error('no audio here');
      },
    });
    exploding.unlock();
    expect(() => exploding.play('gold')).not.toThrow();
  });
});
