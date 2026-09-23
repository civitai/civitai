import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * "A checkpoint needs a SafeTensor weight file" is stated twice and cannot be stated once: the
 * coverage view decides `canGenerate` in SQL, and `checkLoadable` refuses the purchase in
 * TypeScript. Nothing executes the view — the unit suite mocks `$queryRaw` wholesale — so a change
 * to one side is invisible until production disagrees with itself: a Create button on a checkpoint
 * the loader then refuses, or a load offered for something coverage has dropped.
 *
 * This is a TEXT guard over a textual property (the same two literals appear on both sides), which
 * is the one kind a text guard checks well. It does NOT prove the SQL is correct — that was
 * verified by running the view body against the production replica, and the numbers are recorded in
 * the migration header.
 *
 * 🔴 Both halves must also stay CHECKPOINT-SCOPED. Applying the rule to every model type was
 * measured on 2026-09-09 as removing 3,287 covered textual inversions carrying 1.39 BILLION
 * lifetime generations — embeddings ship as PickleTensor and are not served by the loader. That
 * decision is the expensive one here, so it is asserted rather than left to the header comment.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const SERVICE = 'src/server/services/resource-load.service.ts';
const MIGRATIONS = 'packages/civitai-db-schema/prisma/migrations';
const VIEW_DDL = 'CREATE OR REPLACE VIEW "GenerationCoverage"';

/**
 * The LAST migration that redefines the view is the one in force — anchoring on a filename would
 * leave this reading a superseded body the moment the view is edited again.
 */
function currentViewMigration() {
  const dir = path.join(repoRoot, MIGRATIONS);
  const matches = readdirSync(dir)
    .sort()
    .map((name) => ({ name, file: path.join(dir, name, 'migration.sql') }))
    .filter(({ file }) => {
      try {
        return readFileSync(file, 'utf8').includes(VIEW_DDL);
      } catch {
        return false;
      }
    });
  return matches.length
    ? {
        ...matches[matches.length - 1],
        sql: readFileSync(matches[matches.length - 1].file, 'utf8'),
      }
    : null;
}

const migration = currentViewMigration();
const service = readFileSync(path.join(repoRoot, SERVICE), 'utf8');

/** The `ARRAY[...]` in the file test that computes the SafeTensor flag. */
function migrationWeightTypes(sql: string) {
  const block = /type = ANY \(ARRAY\[([^\]]+)\]\)[\s\S]{0,300}?AS is_safetensor/.exec(sql);
  return block ? [...block[1].matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort() : null;
}

/** Where the SafeTensor flag is READ — every read must be gated on the checkpoint test. */
function gatedSafetensorReads(sql: string) {
  return [...sql.matchAll(/ckpt AND \w+\.safetensor/g)].length;
}

function serviceWeightTypes(text: string) {
  const decl = /const LOADABLE_FILE_TYPES = \[([^\]]+)\]/.exec(text);
  return decl ? [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null;
}

describe('the SafeTensor rule has one meaning in SQL and TypeScript', () => {
  it('a migration defining GenerationCoverage exists', () => {
    // Without this the whole file passes vacuously once the migration is renamed or removed.
    expect(migration, `no migration under ${MIGRATIONS} contains \`${VIEW_DDL}\``).not.toBeNull();
  });

  it('the service names SafeTensor as the only loadable format', () => {
    const declared = /const LOADABLE_FORMAT = '([^']+)'/.exec(service);
    expect(declared, `${SERVICE} must declare LOADABLE_FORMAT`).not.toBeNull();
    expect(declared![1]).toBe('SafeTensor');
  });

  it('the view requires the same format literal the service does', () => {
    const declared = /const LOADABLE_FORMAT = '([^']+)'/.exec(service)![1];
    expect(
      migration!.sql,
      `${migration!.name} must require '${declared}' on the checkpoint branch`
    ).toContain(`= '${declared}'`);
  });

  it('both sides accept the same weight file types', () => {
    expect(
      migrationWeightTypes(migration!.sql),
      `${migration!.name}: no weight-type ARRAY found beside the SafeTensor flag — the file test ` +
        `may have been reshaped`
    ).toEqual(serviceWeightTypes(service));
  });

  it('the service applies the format rule to checkpoints only', () => {
    expect(
      service,
      `${SERVICE}: the format check must be scoped to Checkpoint — see the header of ${
        migration!.name
      }`
    ).toMatch(/modelType === 'Checkpoint' &&[\s\S]{0,120}LOADABLE_FORMAT/);
  });

  it('the view reads the SafeTensor flag only under the checkpoint test', () => {
    // The view computes the flag once per version; what keeps the rule checkpoint-scoped is where
    // it is READ. An ungated read applies it to LoRA/TextualInversion/VAE/LoCon/DoRA and drops
    // 3,287 covered embeddings.
    const reads = [...migration!.sql.matchAll(/\w+\.safetensor\b/g)].length;
    const gated = gatedSafetensorReads(migration!.sql);
    expect(
      gated,
      `${
        migration!.name
      }: no \`ckpt AND <alias>.safetensor\` found — the flag must be read under ` +
        `the checkpoint test`
    ).toBeGreaterThan(0);
    expect(
      reads - gated,
      `${migration!.name}: the SafeTensor flag is read ${
        reads - gated
      } time(s) the checkpoint test does not gate`
    ).toBe(0);
  });
});

/**
 * The OTHER SafeTensor rule — a custom training base model must ship SafeTensor weights — CAN be
 * stated once, because both consumers are TypeScript: the main app's `checkCustomModel`
 * (training.orch.ts, format read from the ModelFile row) and the training studio's submit
 * validator (train-core.ts, format read from the orchestrator's `getResource`). Its single home is
 * `@civitai/shared/training-custom-model`; a local `'SafeTensor'`/`'safeTensor'` literal in either
 * consumer is the divergence starting again.
 */
const TRAINING_HELPER = 'packages/civitai-shared/src/training-custom-model.ts';
const TRAINING_ORCH = 'src/server/services/orchestrator/training/training.orch.ts';
const STUDIO_CORE = 'apps/training-studio/src/lib/train-core.ts';
const HELPER_SPECIFIER = "'@civitai/shared/training-custom-model'";

describe('the custom-model training rule has one home', () => {
  const helper = readFileSync(path.join(repoRoot, TRAINING_HELPER), 'utf8');
  const orch = readFileSync(path.join(repoRoot, TRAINING_ORCH), 'utf8');
  const studio = readFileSync(path.join(repoRoot, STUDIO_CORE), 'utf8');

  it('the shared helper states the rule case-insensitively (the DB spells it SafeTensor, the orchestrator safeTensor)', () => {
    expect(helper).toMatch(/toLowerCase\(\) === 'safetensor'/);
  });

  it('the main app imports the rule instead of restating it', () => {
    expect(orch).toContain(HELPER_SPECIFIER);
    expect(orch).not.toMatch(/['"`]safetensor['"`]/i);
  });

  it('the training studio imports the same rule', () => {
    expect(studio).toContain(HELPER_SPECIFIER);
    expect(studio).not.toMatch(/['"`]safetensor['"`]/i);
  });
});
