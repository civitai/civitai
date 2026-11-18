import { describe, expect, it, vi } from 'vitest';
import { createStoredSettingsSource } from './stored';

describe('createStoredSettingsSource', () => {
  it('reads the saved settings from the sources key and keeps them for the ttl', async () => {
    let clock = 0;
    const read = vi.fn(async () =>
      JSON.stringify({
        enabled: true,
        yesNoShare: 0,
        game: { shopDisabled: true, yesNoStretch: 3 },
      })
    );
    const source = createStoredSettingsSource({ read, ttlMs: 30_000, now: () => clock });

    expect(await source.load()).toEqual({ yesNoShare: 0, shopDisabled: true, yesNoStretch: 3 });
    clock = 29_000;
    await source.load();
    expect(read).toHaveBeenCalledTimes(1);
    clock = 31_000;
    await source.load();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('is empty when nothing is saved, so every reader stays on the environment', async () => {
    const source = createStoredSettingsSource({ read: async () => null });
    expect(await source.load()).toEqual({});
  });

  it('keeps the last value when the store fails, and is empty when it fails before any good read', async () => {
    let clock = 0;
    let raw: string | null = null;
    let fail = true;
    const source = createStoredSettingsSource({
      read: async () => {
        if (fail) throw new Error('down');
        return raw;
      },
      ttlMs: 1,
      now: () => clock,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await source.load()).toEqual({});
    fail = false;
    raw = JSON.stringify({ enabled: false, game: { conversionDisabled: true } });
    clock = 10;
    expect(await source.load()).toEqual({ conversionDisabled: true });
    fail = true;
    clock = 20;
    expect(await source.load()).toEqual({ conversionDisabled: true });
  });

  it('treats a store that never answers as a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = createStoredSettingsSource({
      read: () => new Promise<string | null>(() => undefined),
      timeoutMs: 5,
    });
    expect(await source.load()).toEqual({});
  });

  it('shares one read between concurrent loads', async () => {
    const read = vi.fn(async () => JSON.stringify({ game: { yesNoStretch: 2 } }));
    const source = createStoredSettingsSource({ read });
    await Promise.all([source.load(), source.load(), source.load()]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
