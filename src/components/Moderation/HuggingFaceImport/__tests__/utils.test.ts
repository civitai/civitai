import { describe, expect, it } from 'vitest';
import { byGroup } from '~/components/Moderation/HuggingFaceImport/utils';
import type { HuggingFaceImportView } from '~/server/services/huggingface-import.service';

const row = (over: Partial<HuggingFaceImportView>) =>
  ({
    id: 1,
    groupName: 'flux-krea',
    repo: 'black-forest-labs/FLUX.1-Krea-dev',
    revision: 'aaaaaaa1',
    filename: 'model.safetensors',
    sizeBytes: 100,
    createdAt: new Date('2026-09-01'),
    ...over,
  } as HuggingFaceImportView);

describe('byGroup', () => {
  it('keeps a group name that contains spaces intact', () => {
    // Group names are free text a moderator types, so anything that re-parses a joined key renders
    // the wrong label and collides two groups onto one React key.
    const groups = byGroup([
      row({ id: 1, groupName: 'FLUX Krea batch' }),
      row({ id: 2, groupName: 'FLUX Dev batch' }),
    ]);
    expect(groups.map((g) => g.groupName).sort()).toEqual(['FLUX Dev batch', 'FLUX Krea batch']);
  });

  it('separates two revisions of the same repo', () => {
    // The default group name is derived from the repo, so both revisions carry the same name.
    const groups = byGroup([
      row({ id: 1, revision: 'aaaaaaa1' }),
      row({ id: 2, revision: 'bbbbbbb2' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.revision).sort()).toEqual(['aaaaaaa1', 'bbbbbbb2']);
  });

  it('sums bytes and reports the oldest import in the group', () => {
    const groups = byGroup([
      row({ id: 1, sizeBytes: 100, createdAt: new Date('2026-09-05') }),
      row({ id: 2, sizeBytes: 250, createdAt: new Date('2026-09-02') }),
      row({ id: 3, sizeBytes: null, createdAt: new Date('2026-09-09') }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].bytes).toBe(350);
    expect(groups[0].oldest).toEqual(new Date('2026-09-02'));
  });
});
