import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getGenerationFile } from '~/server/utils/resource-air';

/**
 * The orchestrator caches a resource per AIR string, and the AIR of a Checkpoint depends on which
 * of its files is chosen. Every surface that submits, describes or invalidates a generation AIR
 * therefore has to choose the same file — when one chose differently, the cache bust hit
 * `...:checkpoint:...` while generation ran under `...:diffusionmodel:...`, and a version stayed
 * "not enabled for generation" after it was enabled.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

/** Where an AIR may be built without `modelVersionToAir`, and why. */
const AIR_ALLOWLIST = [
  'src/shared/utils/air.ts',
  'src/server/utils/resource-air.ts',
  // Epoch resources are orchestrator-hosted; the civitai arm takes its file from getGenerationFile.
  'src/server/services/generation/generation.service.ts',
  // What the orchestrator reads. Default pick is getGenerationFile; an explicit modelFileId adds
  // `+<fileId>`, and the epoch arm addresses an orchestrator-hosted file, not a civitai one.
  'src/pages/api/v1/model-versions/mini/[id].ts',
  // A model-file scan addresses one file by id, not a generation resource.
  'src/server/services/orchestrator/orchestrator.service.ts',
  // Client display of the file the viewer selected, and training inputs — not generation.
  'src/components/Model/ModelURN/ModelURN.tsx',
  'src/components/Resource/Forms/TrainingSelectFile.tsx',
  'src/components/Training/Form/TrainingSubmitModelSelect.tsx',
  'src/pages/training-studio/index.tsx',
] as const;

const AIR_CALLS_PER_FILE: Record<string, number> = {
  'src/server/services/generation/generation.service.ts': 1,
  'src/server/services/orchestrator/orchestrator.service.ts': 1,
  'src/pages/api/v1/model-versions/mini/[id].ts': 2,
};

/** Surfaces that pick a generation file, which must never fall back to `getPrimaryFile`. */ const GENERATION_FILE_READERS =
  [
    'src/server/services/generation/generation.service.ts',
    'src/server/services/resource-load.service.ts',
    'src/server/services/resource-residency.service.ts',
    'src/server/services/orchestrator/models.ts',
  ] as const;

function stripComments(text: string) {
  const block = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  const line = new RegExp('//[^\\n]*', 'g');
  return text.replace(block, '').replace(line, '');
}

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(path.join(repoRoot, 'src'))
  .map((full) => ({
    rel: path.relative(repoRoot, full).split(path.sep).join('/'),
    text: stripComments(readFileSync(full, 'utf8')),
  }))
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

const read = (rel: string) => stripComments(readFileSync(path.join(repoRoot, rel), 'utf8'));

const file = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'Model',
  visibility: 'Public',
  replacedAt: null as Date | null,
  metadata: { format: 'SafeTensor' as const, size: 'pruned' as const, fp: 'bf16' as const },
  ...overrides,
});

describe('the generation file is chosen in one place', () => {
  it('builds AIRs only in the allowlisted files', () => {
    const offenders = sourceFiles
      .filter((f) => /\bstringifyAIR\(|\bAir\.stringify\(/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => !(AIR_ALLOWLIST as readonly string[]).includes(rel));
    expect(
      offenders,
      'build the AIR with modelVersionToAir, or allowlist it with a reason'
    ).toEqual([]);
  });

  it.each(AIR_ALLOWLIST)('%s still builds an AIR, or it leaves the allowlist', (rel) => {
    expect(read(rel)).toMatch(/\bstringifyAIR\(|\bAir\.stringify\(/);
  });

  // A whole-file allowlist would exempt a second construction in these large files.
  it.each(Object.entries(AIR_CALLS_PER_FILE))('%s builds exactly %i AIR(s)', (rel, count) => {
    expect(read(rel).match(/\bstringifyAIR\(/g) ?? []).toHaveLength(count);
  });

  it.each(GENERATION_FILE_READERS)('%s never picks a file another way', (rel) => {
    expect(read(rel)).not.toMatch(/\b(getPrimaryFile|resolveActiveFile)\(/);
  });

  it.each([
    'src/server/services/generation/generation.service.ts',
    'src/pages/api/v1/model-versions/mini/[id].ts',
  ])('%s picks its generation file with getGenerationFile', (rel) => {
    expect(read(rel)).toMatch(/\bgetGenerationFile\(/);
  });
});

describe('getGenerationFile', () => {
  it('ignores query row order — ties go to the oldest file', () => {
    const bf16 = file(10);
    const fp8 = file(20, { metadata: { ...bf16.metadata, fp: 'fp8' } });
    expect(getGenerationFile([fp8, bf16])?.id).toBe(10);
    expect(getGenerationFile([bf16, fp8])?.id).toBe(10);
  });

  it('never picks a replaced file', () => {
    expect(getGenerationFile([file(10, { replacedAt: new Date() }), file(20)])?.id).toBe(20);
  });

  it('prefers a public file over a better-scoring private one', () => {
    const privateFp16 = file(10, {
      visibility: 'Private',
      metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
    });
    const sensitiveFp16 = { ...privateFp16, id: 15, visibility: 'Sensitive' };
    const publicDiffusion = file(20, { type: 'Diffusion Model' });
    expect(getGenerationFile([privateFp16, sensitiveFp16, publicDiffusion])?.id).toBe(20);
  });

  it('falls back to non-public files when a version has no public one', () => {
    expect(getGenerationFile([file(10, { visibility: 'Private' })])?.id).toBe(10);
  });

  it('returns null when every file is replaced', () => {
    expect(getGenerationFile([file(10, { replacedAt: new Date() })])).toBeNull();
  });
});
