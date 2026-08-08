import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageMetaProps } from '~/server/schema/image.schema';

const mocks = vi.hoisted(() => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
  getToolIdsByAliasesOrNames: vi.fn(),
}));

vi.mock('~/server/services/tool.service', () => mocks);

import { resolveImageToolIds } from '~/server/services/image-tool.service';

const meta = (value: Record<string, unknown>) => value as ImageMetaProps;

describe('resolveImageToolIds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getToolIdsByAliasesOrNames.mockResolvedValue([]);
  });

  it('preserves the existing engine-only attribution', async () => {
    mocks.getToolByAlias.mockResolvedValue({ id: 101 });

    await expect(resolveImageToolIds(meta({ engine: 'ComfyUI' }))).resolves.toEqual([101]);
    expect(mocks.getToolIdsByAliasesOrNames).not.toHaveBeenCalled();
  });

  it('adds metadata-declared tools to the engine tool', async () => {
    mocks.getToolByAlias.mockResolvedValue({ id: 101 });
    mocks.getToolIdsByAliasesOrNames.mockResolvedValue([202]);

    await expect(
      resolveImageToolIds(meta({ engine: 'ComfyUI', tools: ['Post Processor'] }))
    ).resolves.toEqual([101, 202]);
  });

  it('ignores unknown additional tools', async () => {
    mocks.getToolByAlias.mockResolvedValue({ id: 101 });

    await expect(
      resolveImageToolIds(meta({ engine: 'ComfyUI', tools: ['Unknown Tool'] }))
    ).resolves.toEqual([101]);
  });

  it('deduplicates tools resolved from multiple metadata sources', async () => {
    mocks.getToolByAlias.mockResolvedValue({ id: 101 });
    mocks.getToolIdsByAliasesOrNames.mockResolvedValue([101, 202, 202]);

    await expect(
      resolveImageToolIds(meta({ engine: 'ComfyUI', tools: ['ComfyUI', 'Post Processor'] }))
    ).resolves.toEqual([101, 202]);
  });

  it('discards malformed entries and bounds oversized lists', async () => {
    const names = Array.from({ length: 30 }, (_, index) => `Tool ${index}`);
    mocks.getToolIdsByAliasesOrNames.mockResolvedValue([]);

    await resolveImageToolIds(meta({ tools: [false, ...names] }));

    expect(mocks.getToolIdsByAliasesOrNames).toHaveBeenCalledWith(names.slice(0, 9));
  });

  it('coexists with the existing external source fallback', async () => {
    mocks.getToolByName.mockResolvedValue({ id: 303 });
    mocks.getToolIdsByAliasesOrNames.mockResolvedValue([202]);

    await expect(
      resolveImageToolIds(
        meta({ external: { source: { name: 'External Generator' } }, tools: ['Post Processor'] })
      )
    ).resolves.toEqual([303, 202]);
  });

  it('returns no attribution when metadata has no resolvable tools', async () => {
    await expect(resolveImageToolIds(meta({}))).resolves.toBeUndefined();
    await expect(resolveImageToolIds(undefined)).resolves.toBeUndefined();
  });

  it('does not fail the upload path when additional-tool lookup fails', async () => {
    mocks.getToolByAlias.mockResolvedValue({ id: 101 });
    mocks.getToolIdsByAliasesOrNames.mockRejectedValue(new Error('database unavailable'));

    await expect(
      resolveImageToolIds(meta({ engine: 'ComfyUI', tools: ['Post Processor'] }))
    ).resolves.toEqual([101]);
  });
});
