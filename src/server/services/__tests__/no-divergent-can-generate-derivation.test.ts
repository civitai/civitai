import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { isGenerationEligible } from '@civitai/shared/generation-eligibility';
import { ModelType } from '~/shared/utils/prisma/enums';

/**
 * "Can this version generate" needs BOTH halves, and only one module may compose them.
 *
 * `GenerationCoverage.covered` and `isBaseModelGenerationSupported()` answer different questions.
 * Only the database knows licence, scan state, status and POI. Only `basemodel.constants.ts` knows
 * which MODEL TYPES an ecosystem supports — the view's type branch is one flat list applied to
 * every base model, so it reports LORA/LoCon/DoRA/VAE/TextualInversion versions as covered on
 * ecosystems that cannot generate with them. Measured against production 2026-09-08: **736 versions
 * across 33 (baseModel, type) pairs**, led by Wan Video + LORA (337) and Flux.1 D + DoRA (102).
 *
 * So the pair is correct and neither half can be dropped. The risk is that it is COMPOSED BY HAND
 * at each call site: it was, at three of them (the models search index twice, and model.service),
 * plus the batch resolver in generation.service. A fourth consumer that reads `covered` alone would
 * offer those 736 a paid model load — charging for a resource search already hides and the
 * orchestrator cannot generate with. That fourth consumer is the one being written now.
 *
 * Same shape, and the same reason, as `no-divergent-paid-gate-derivation`.
 *
 * WHY A TEXT GUARD. The composition cannot be required by a type: `covered` is a plain boolean off
 * a Prisma select, and nothing stops a caller reading it. What CAN be checked is that the
 * ecosystem-support function has exactly one caller, which is a textual property — the kind a text
 * guard checks well.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO_ROOT, 'src');
const HELPER = '@civitai/shared/generation-eligibility';

/**
 * The constants-side halves of the derivation. Both answer a question the view cannot:
 * which model TYPES an ecosystem generates, and whether it pins the checkpoint to its own
 * versions. Each is read only by `isGenerationEligible`.
 */
const GATE_HELPERS = ['isBaseModelGenerationSupported', 'isModelLockedBaseModel'];

/**
 * Files under `src/` allowed to name a `GATE_HELPERS` entry. Empty on purpose: the only legitimate
 * caller is `isGenerationEligible`, which lives in `packages/civitai-shared`. Adding a line here is
 * the change that must be visible in review.
 */
const ALLOWLIST: readonly string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * 🔴 Called from INSIDE the tests, never at module scope. Thrown from a `describe` body this would
 * be a COLLECTION failure: the file contributes zero tests, the suite's failure count does not
 * move, and the guard is silently absent from every full-suite run.
 */
function scan() {
  const directCallers: string[] = [];
  const helperImporters: string[] = [];

  for (const file of walk(SRC)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    // Tests may call it directly — they are asserting on it, not deriving a gate from it.
    if (rel.includes('__tests__') || /\.test\.tsx?$/.test(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (GATE_HELPERS.some((name) => source.includes(name))) directCallers.push(rel);
    if (source.includes(HELPER)) helperImporters.push(rel);
  }

  return { directCallers, helperImporters };
}

describe('canGenerate is derived in one place', () => {
  it('nothing under src/ calls the constants-side gate helpers directly', () => {
    const { directCallers } = scan();
    expect(
      directCallers.filter((f) => !ALLOWLIST.includes(f)),
      'Coverage alone is not canGenerate — the ecosystem must also support this model TYPE. Compose ' +
        'both through `isGenerationEligible` from @civitai/shared/generation-eligibility instead of ' +
        'pairing them by hand. A consumer that reads `covered` alone over-reports by 736 versions, ' +
        'and for paid model loading that means charging for a load the orchestrator cannot use.'
    ).toEqual([]);
  });

  it('the allowlist is empty, and shrinking it is the only allowed direction', () => {
    // A ratchet, not a snapshot: this fails if someone adds an exemption, so the list cannot grow
    // quietly the way the paid-gate one did.
    expect(ALLOWLIST).toEqual([]);
  });

  it('the helper is actually used — a guard over zero call sites guards nothing', () => {
    const { helperImporters } = scan();
    expect(helperImporters.length).toBeGreaterThan(0);
  });

  it('requires the ecosystem to support the model type, not just coverage', () => {
    // Flux.1 D covers DoRA in the view and does not support it for generation — 102 versions.
    expect(
      isGenerationEligible({
        covered: true,
        coveredLive: true,
        baseModel: 'Flux.1 D',
        modelType: ModelType.DoRA,
        flags: 0,
      })
    ).toBe(false);
  });

  it('is true when coverage and ecosystem support agree', () => {
    expect(
      isGenerationEligible({
        covered: true,
        coveredLive: true,
        baseModel: 'Flux.1 D',
        modelType: ModelType.LORA,
        flags: 0,
      })
    ).toBe(true);
  });

  it('is false without coverage, however well supported the type is', () => {
    expect(
      isGenerationEligible({
        covered: false,
        coveredLive: false,
        baseModel: 'Flux.1 D',
        modelType: ModelType.LORA,
        flags: 0,
      })
    ).toBe(false);
  });
});

/**
 * The second half of the same rule: an ecosystem that pins its checkpoint gets no staged expansion.
 *
 * `checkpointDef` rewrites a checkpoint id outside the workflow's own list back to the
 * default, on the SERVER parse as well as in the form, so a community checkpoint on one of those
 * ecosystems reaches no handler however it was selected — and the staged rule was offering it as a
 * paid load anyway. Held to the live rule instead, which admits a checkpoint only through
 * `EcosystemCheckpoints`, the auction, or file-less API coverage.
 *
 * A revert shows up as a Qwen community checkpoint reading eligible, not as a count moving.
 */
describe('a model-locked ecosystem gets no staged expansion', () => {
  const qwenCheckpoint = { baseModel: 'Qwen', modelType: ModelType.Checkpoint, flags: 0 };

  it('refuses a checkpoint the staged rule covers and the live rule does not', () => {
    expect(isGenerationEligible({ ...qwenCheckpoint, covered: true, coveredLive: false })).toBe(
      false
    );
  });

  it('keeps one the live rule covers — the ecosystem defaults ride on that column', () => {
    expect(isGenerationEligible({ ...qwenCheckpoint, covered: true, coveredLive: true })).toBe(
      true
    );
  });

  it('leaves non-checkpoints on the same ecosystem alone — their handlers do pass resource AIRs', () => {
    expect(
      isGenerationEligible({
        covered: true,
        coveredLive: false,
        baseModel: 'Qwen',
        modelType: ModelType.LORA,
        flags: 0,
      })
    ).toBe(true);
  });

  it('leaves an unlocked ecosystem alone — this is what the expansion is for', () => {
    expect(
      isGenerationEligible({
        covered: true,
        coveredLive: false,
        baseModel: 'Illustrious',
        modelType: ModelType.Checkpoint,
        flags: 0,
      })
    ).toBe(true);
  });

  it('fails CLOSED when the live answer is missing, not back to the staged one', () => {
    // The tempting fix for a call site that cannot easily supply the column is `coveredLive ??
    // covered`, which re-opens the hole wherever it is reached. An absent live answer must refuse.
    expect(isGenerationEligible({ ...qwenCheckpoint, covered: true, coveredLive: undefined })).toBe(
      false
    );
  });
});
