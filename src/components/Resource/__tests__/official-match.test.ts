import { describe, it, expect, vi } from 'vitest';
import { resolveOfficialMatch } from '~/components/Resource/official-match';

const file = { size: 1000 } as File;
const match = { versionId: 42, fileId: 900, modelId: 7, modelName: 'Boogu VAE', versionName: 'v1', fileName: 'x', sizeKB: 1, componentType: 'VAE' } as const;

const deps = (over = {}) => ({
  file, hostType: 'VAE',
  findBySize: vi.fn().mockResolvedValue([{ id: 900 }]),
  hashFile: vi.fn().mockResolvedValue('abc'),
  findByHash: vi.fn().mockResolvedValue(match),
  ...over,
});

describe('resolveOfficialMatch', () => {
  it('returns the match when size collides and hash confirms', async () => {
    expect(await resolveOfficialMatch(deps())).toEqual(match);
  });

  it('returns null (no hashing) for a primary-weights host', async () => {
    const d = deps({ hostType: 'Model' });
    expect(await resolveOfficialMatch(d)).toBeNull();
    expect(d.findBySize).not.toHaveBeenCalled();
    expect(d.hashFile).not.toHaveBeenCalled();
    expect(d.findByHash).not.toHaveBeenCalled();
  });

  it('returns null (no hashing) when no official file shares the size', async () => {
    const d = deps({ findBySize: vi.fn().mockResolvedValue([]) });
    expect(await resolveOfficialMatch(d)).toBeNull();
    expect(d.hashFile).not.toHaveBeenCalled();
  });

  it('returns null when the file is over the hash cap (hashFile → null)', async () => {
    const d = deps({ hashFile: vi.fn().mockResolvedValue(null) });
    expect(await resolveOfficialMatch(d)).toBeNull();
    expect(d.findByHash).not.toHaveBeenCalled();
  });
});
