import { describe, it, expect, vi } from 'vitest';
import { resolveOfficialFileHash } from '~/components/Resource/official-match';

const file = { size: 1000 } as File;

const deps = (over = {}) => ({
  file, hostType: 'VAE',
  findBySize: vi.fn().mockResolvedValue([{ id: 900 }]),
  hashFile: vi.fn().mockResolvedValue('abc123'),
  onHashStart: vi.fn(),
  ...over,
});

describe('resolveOfficialFileHash', () => {
  it('returns the sha256 when size collides and hash succeeds', async () => {
    expect(await resolveOfficialFileHash(deps())).toBe('abc123');
  });

  it('fires onHashStart exactly once, only when hashing begins', async () => {
    const d = deps();
    await resolveOfficialFileHash(d);
    expect(d.onHashStart).toHaveBeenCalledTimes(1);
  });

  it('returns null (no hashing) for a primary-weights host', async () => {
    const d = deps({ hostType: 'Model' });
    expect(await resolveOfficialFileHash(d)).toBeNull();
    expect(d.findBySize).not.toHaveBeenCalled();
    expect(d.hashFile).not.toHaveBeenCalled();
    expect(d.onHashStart).not.toHaveBeenCalled();
  });

  it('returns null (no hashing) when no official file shares the size', async () => {
    const d = deps({ findBySize: vi.fn().mockResolvedValue([]) });
    expect(await resolveOfficialFileHash(d)).toBeNull();
    expect(d.hashFile).not.toHaveBeenCalled();
    expect(d.onHashStart).not.toHaveBeenCalled();
  });

  it('returns null when the file is over the hash cap (hashFile → null)', async () => {
    const d = deps({ hashFile: vi.fn().mockResolvedValue(null) });
    expect(await resolveOfficialFileHash(d)).toBeNull();
  });
});
