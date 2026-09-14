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
const VIEW_DDL = 'CREATE OR REPLACE VIEW "GenerationCoverageNext"';

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

/** The `ARRAY[...]` inside the checkpoint disjunct's own EXISTS, keyed on its `mf2` alias. */
function migrationWeightTypes(sql: string) {
  const block = /mf2\.type = ANY \(ARRAY\[([^\]]+)\]\)/.exec(sql);
  return block ? [...block[1].matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort() : null;
}

function serviceWeightTypes(text: string) {
  const decl = /const LOADABLE_FILE_TYPES = \[([^\]]+)\]/.exec(text);
  return decl ? [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null;
}

describe('the SafeTensor rule has one meaning in SQL and TypeScript', () => {
  it('a migration defining GenerationCoverageNext exists', () => {
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
      `${migration!.name}: no mf2.type ARRAY found — the checkpoint EXISTS may have been reshaped`
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

  it('the view applies the format rule inside the checkpoint disjunct, not the shared EXISTS', () => {
    // The shared clause is keyed on `mf`; the checkpoint-only one on `mf2`. A SafeTensor test
    // appearing against `mf` would mean the rule escaped onto every model type.
    const shared = /mf\.metadata ->> 'format'::text = 'SafeTensor'/.test(migration!.sql);
    expect(
      shared,
      `${
        migration!.name
      }: SafeTensor must not be required in the shared EXISTS — that applies it ` +
        `to LoRA/TextualInversion/VAE/LoCon/DoRA and drops 3,287 covered embeddings`
    ).toBe(false);

    const checkpointScoped =
      /m\.type = 'Checkpoint'::"ModelType"[\s\S]{0,900}mf2\.metadata ->> 'format'::text = 'SafeTensor'/.test(
        migration!.sql
      );
    expect(
      checkpointScoped,
      `${migration!.name}: the SafeTensor EXISTS must sit inside the Checkpoint disjunct`
    ).toBe(true);
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
