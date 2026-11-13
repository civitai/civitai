import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The "training paused" flag is a moderator control on a paid submit. A failed or slow read of it
// must never read as "available": the reader answers with the last value it read in this process,
// and with "paused" (and a message saying why) when it has never read one.

const hGet = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
const logToAxiom = vi.hoisted(() => vi.fn());
vi.mock('./redis', () => ({ getSysRedis: () => ({ hGet }) }));
vi.mock('./axiom', () => ({ logToAxiom, safeError: (e: unknown) => String(e) }));

type Module = typeof import('./service-status');
let mod: Module;

const PAUSED = JSON.stringify({ available: false, message: 'Paused for maintenance.' });
const OPEN = JSON.stringify({ available: true, message: 'All good.' });

beforeEach(async () => {
  hGet.mockReset();
  logToAxiom.mockReset();
  // A fresh module per test: the last-known value is per process.
  vi.resetModules();
  mod = await import('./service-status');
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.TRAINING_STATUS_FAIL_CLOSED;
});

describe('getTrainingServiceStatus', () => {
  it('serves the stored status when the read succeeds', async () => {
    hGet.mockResolvedValue(PAUSED);
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({
      available: false,
      message: 'Paused for maintenance.',
    });
  });

  it('CONTROL: no stored status is a KNOWN "available" (the key is simply unset)', async () => {
    hGet.mockResolvedValue(null);
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({ available: true });
  });

  it('a failed read with nothing known treats training as paused, with a clear message', async () => {
    hGet.mockRejectedValue(new Error('sys redis is down'));
    await expect(mod.getTrainingServiceStatus()).resolves.toEqual({
      available: false,
      message: mod.TRAINING_STATUS_UNKNOWN_MESSAGE,
      blockedModels: [],
      blockedModelReasons: {},
    });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'training-studio-status-read', served: 'fail-closed' })
    );
  });

  it('a failed read keeps an operator\'s "paused" from the last good read', async () => {
    hGet.mockResolvedValueOnce(PAUSED);
    await mod.getTrainingServiceStatus();
    hGet.mockRejectedValue(new Error('sys redis is down'));
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({
      available: false,
      message: 'Paused for maintenance.',
    });
    expect(logToAxiom).toHaveBeenCalledWith(expect.objectContaining({ served: 'last-known-good' }));
  });

  it('a failed read keeps "available" from the last good read (no needless outage)', async () => {
    hGet.mockResolvedValueOnce(OPEN);
    await mod.getTrainingServiceStatus();
    hGet.mockRejectedValue(new Error('sys redis is down'));
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({
      available: true,
      message: 'All good.',
    });
  });

  it('a read that never settles is a failed read, not "available"', async () => {
    vi.useFakeTimers();
    hGet.mockReturnValue(new Promise(() => undefined));
    const pending = mod.getTrainingServiceStatus();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({
      available: false,
      message: mod.TRAINING_STATUS_UNKNOWN_MESSAGE,
    });
  });

  it.each(['off', 'OFF', '0', 'false'])(
    'TRAINING_STATUS_FAIL_CLOSED=%s restores the old fail-open read ("available")',
    async (value) => {
      process.env.TRAINING_STATUS_FAIL_CLOSED = value;
      hGet.mockResolvedValueOnce(PAUSED);
      await mod.getTrainingServiceStatus();
      hGet.mockRejectedValue(new Error('sys redis is down'));
      await expect(mod.getTrainingServiceStatus()).resolves.toEqual({
        available: true,
        message: null,
        blockedModels: [],
        blockedModelReasons: {},
      });
    }
  );

  it('TRAINING_STATUS_FAIL_CLOSED=off: a never-read status is available too', async () => {
    process.env.TRAINING_STATUS_FAIL_CLOSED = 'off';
    hGet.mockRejectedValue(new Error('sys redis is down'));
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({ available: true });
  });

  it('an unknown TRAINING_STATUS_FAIL_CLOSED value keeps the fail-closed read', async () => {
    process.env.TRAINING_STATUS_FAIL_CLOSED = 'on';
    hGet.mockRejectedValue(new Error('sys redis is down'));
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({
      available: false,
      message: mod.TRAINING_STATUS_UNKNOWN_MESSAGE,
    });
  });

  it('a stored value that is not JSON still reads as available (a bad value never blocks training)', async () => {
    hGet.mockResolvedValue('{not json');
    await expect(mod.getTrainingServiceStatus()).resolves.toMatchObject({ available: true });
  });
});
