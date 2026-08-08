import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolveImageToolIds } from '~/server/services/image-tool.service';
import { ExifParser } from '~/utils/metadata';

const toolMocks = vi.hoisted(() => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
  getToolIdsByAliasesOrNames: vi.fn(),
}));

vi.mock('~/server/services/tool.service', () => toolMocks);

async function readFixture(name: string) {
  const bytes = await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as unknown as File;
}

describe('additional tool metadata end to end', () => {
  it('keeps normal ComfyUI attribution unchanged when no tools are declared', async () => {
    const parser = await ExifParser(await readFixture('comfyui-standard.png'));
    const metadata = await parser.getMetadata();

    expect(metadata).toMatchObject({ engine: 'ComfyUI' });
    expect(metadata.tools).toBeUndefined();
  });

  it('reads additional tool declarations through ExifReader and the selected parser', async () => {
    const parser = await ExifParser(await readFixture('comfyui-additional-tools.png'));
    const metadata = await parser.getMetadata();

    expect(parser.exif.parameters).toContain('Steps: 20');
    expect(parser.exif.prompt).toBeDefined();
    expect(parser.exif.workflow).toBeDefined();
    expect(metadata.engine).toBe('ComfyUI');
    expect(metadata.tools).toEqual(['Example Tool']);

    toolMocks.getToolByAlias.mockResolvedValue({ id: 101 });
    toolMocks.getToolIdsByAliasesOrNames.mockResolvedValue([202]);
    await expect(resolveImageToolIds(metadata)).resolves.toEqual([101, 202]);
  });

  it('preserves declarations when the selected parser throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const parser = await ExifParser(await readFixture('malformed-comfy-with-declarations.png'));

      await expect(parser.getMetadata()).resolves.toEqual({
        engine: 'ComfyUI',
        tools: ['Example Tool'],
      });
      expect(consoleError).toHaveBeenCalledWith('Error parsing metadata', expect.anything());
    } finally {
      consoleError.mockRestore();
    }
  });
});
