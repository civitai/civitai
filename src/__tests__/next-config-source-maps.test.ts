import { describe, expect, it } from 'vitest';

/**
 * Release builds emit SERVER source maps (they de-minify server CPU profiles; the Dockerfile
 * stages them into the separate `maps` image) and NO browser maps (the larger build-memory cost).
 *
 * Next 16.4.5's Turbopack resolves the two as
 *   client = experimental.turbopackSourceMaps ?? productionBrowserSourceMaps
 *   server = experimental.turbopackSourceMaps ?? experimental.serverSourceMaps ?? true
 * so all three keys are pinned: `turbopackSourceMaps` set to EITHER value would override both.
 *
 * Reads the real exported config object, not the file text: a text scan passes on a setting
 * that never reaches the export.
 */

async function loadConfig() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import('../../next.config.mjs')).default as any;
}

describe('next.config source maps', () => {
  it('keeps browser source maps OFF', async () => {
    expect((await loadConfig()).productionBrowserSourceMaps).toBe(false);
  });

  it('turns server source maps ON', async () => {
    expect((await loadConfig()).experimental?.serverSourceMaps).toBe(true);
  });

  it('leaves experimental.turbopackSourceMaps unset (it would override both switches)', async () => {
    const config = await loadConfig();
    expect(config.experimental ?? {}).not.toHaveProperty('turbopackSourceMaps');
    expect(config).not.toHaveProperty('turbopackSourceMaps');
  });
});
