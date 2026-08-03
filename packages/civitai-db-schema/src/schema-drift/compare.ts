import type {
  CatalogForeignKey,
  DbCatalog,
  DriftCounts,
  DriftFinding,
  DriftReport,
  ParsedModel,
  ParsedSchema,
  SkippedModel,
  SkippedRelation,
} from './types';

/** Join column names into a lookup key. NUL cannot appear in a Postgres identifier. */
function key(columns: readonly string[]): string {
  return columns.join('\u0000');
}

/**
 * Guard against a catalog read that silently answered the same thing for every row.
 *
 * The motivating case: `SELECT a.attnotnull notnull` — `NOTNULL` is a reserved word, so
 * Postgres parses that as the postfix `IS NOT NULL` operator and returns a constant `true`.
 * The query succeeds, the column is populated, and every nullable column in the database
 * reads as NOT NULL: 626 fabricated findings, all pointing the same direction.
 *
 * A real schema of any size has both nullable and non-nullable columns, so a uniform
 * answer over many columns is a broken read, not a finding. This is the positive control
 * for the catalog: it fails loudly rather than letting the differ report the fabrication.
 */
export function assertCatalogSanity(catalog: DbCatalog, minColumns = 50): void {
  const { columns } = catalog;
  if (columns.length < minColumns) return; // too small to conclude anything
  const notNull = columns.filter((c) => c.notNull).length;
  if (notNull === 0 || notNull === columns.length) {
    throw new Error(
      `Catalog read looks broken: all ${columns.length} columns report notNull=${notNull > 0}. ` +
        'A real schema has a mix. Check that the nullability column is not aliased to the ' +
        'reserved word NOTNULL (which parses as the postfix IS NOT NULL operator).'
    );
  }
}

interface CatalogIndex {
  tables: Set<string>;
  columns: Map<string, boolean>;
  foreignKeys: Map<string, CatalogForeignKey>;
  uniqueIndexes: Set<string>;
}

function indexCatalog(catalog: DbCatalog): CatalogIndex {
  const columns = new Map<string, boolean>();
  for (const c of catalog.columns) columns.set(key([c.table, c.column]), c.notNull);

  const foreignKeys = new Map<string, CatalogForeignKey>();
  for (const fk of catalog.foreignKeys) {
    // Matched on the ORDERED constrained-column tuple: a composite FK on (a, b) is a
    // different constraint from one on (b, a).
    foreignKeys.set(key([fk.table, ...fk.columns]), fk);
  }

  const uniqueIndexes = new Set<string>();
  for (const u of catalog.uniqueIndexes) uniqueIndexes.add(key([u.table, ...u.columns]));

  return { tables: new Set(catalog.tables), columns, foreignKeys, uniqueIndexes };
}

function columnFor(model: ParsedModel, fieldName: string): string | null {
  const field = model.fields.find((f) => f.name === fieldName);
  return field ? field.column : null;
}

function emptyCounts(): DriftCounts {
  return {
    declaredRelations: 0,
    relationsChecked: 0,
    relationsSkipped: 0,
    missingForeignKeys: 0,
    referentialActionDrifts: 0,
    referentialActionUnknown: 0,
    columnsChecked: 0,
    nullabilityDrifts: 0,
    uniqueDeclarationsChecked: 0,
    uniquenessDrifts: 0,
  };
}

/**
 * Compare a parsed Prisma schema against a database catalog.
 *
 * Pure: no I/O, no database, no clock. Everything it knows comes from its two arguments,
 * which is what lets the tests drive it with a curated fixture and with a deliberately
 * damaged one.
 */
export function compareSchemaToCatalog(schema: ParsedSchema, catalog: DbCatalog): DriftReport {
  const live = indexCatalog(catalog);
  const counts = emptyCounts();
  const findings: DriftFinding[] = [];
  const skippedRelations: SkippedRelation[] = [];
  const skippedModels: SkippedModel[] = [];

  const modelsByName = new Map(schema.models.map((m) => [m.name, m]));

  for (const model of schema.models) {
    counts.declaredRelations += model.relations.length;

    // A model Prisma does not manage, or one backed by a view or a table that no longer
    // exists, is skipped wholesale. Reporting it would be noise, not drift: there is no
    // table for a constraint to live on.
    const unmanaged = model.ignored
      ? 'model carries @@ignore'
      : !live.tables.has(model.table)
      ? `table "${model.table}" is not an ordinary table (view, or absent)`
      : null;

    if (unmanaged) {
      skippedModels.push({ model: model.name, table: model.table, reason: unmanaged });
      counts.relationsSkipped += model.relations.length;
      for (const relation of model.relations) {
        skippedRelations.push({
          model: model.name,
          table: model.table,
          field: relation.field,
          reason: unmanaged,
        });
      }
      continue;
    }

    checkRelations(model, modelsByName, live, counts, findings);
    checkNullability(model, live, counts, findings);
    checkUniqueness(model, live, counts, findings);
  }

  return { counts, findings, skippedRelations, skippedModels };
}

function checkRelations(
  model: ParsedModel,
  modelsByName: Map<string, ParsedModel>,
  live: CatalogIndex,
  counts: DriftCounts,
  findings: DriftFinding[]
): void {
  for (const relation of model.relations) {
    // The referenced column is whatever `references: [...]` names — never assumed to be
    // `id`. Most relations here do reference `id`, but a handful reference composite or
    // non-`id` keys, and hardcoding `id` would silently mis-describe those.
    const columns = relation.fields.map((f) => columnFor(model, f) ?? f);
    const target = modelsByName.get(relation.targetModel);
    const refTable = target ? target.table : relation.targetModel;
    const refColumns = relation.references.map((f) => (target ? columnFor(target, f) ?? f : f));

    counts.relationsChecked += 1;

    const fk = live.foreignKeys.get(key([model.table, ...columns]));
    if (!fk) {
      counts.missingForeignKeys += 1;
      findings.push({
        kind: 'missing-foreign-key',
        table: model.table,
        columns,
        model: model.name,
        field: relation.field,
        declared: `FOREIGN KEY -> ${refTable}(${refColumns.join(', ')}) ON DELETE ${
          relation.onDelete
        } ON UPDATE ${relation.onUpdate}`,
        actual: 'no foreign key on these columns',
        detail: relation.onDeleteExplicit
          ? undefined
          : `onDelete not written; Prisma defaults a ${
              relation.optional ? 'optional' : 'required'
            } relation to ${relation.onDelete}`,
      });
      continue;
    }

    // Present-but-wrong-action: the constraint exists, so nothing looks missing, but the
    // database enforces a different rule than the schema promises.
    if (fk.onDelete === null || fk.onUpdate === null) {
      counts.referentialActionUnknown += 1;
      continue;
    }

    const deltas: string[] = [];
    if (fk.onDelete !== relation.onDelete) {
      deltas.push(`ON DELETE declared ${relation.onDelete}, database has ${fk.onDelete}`);
    }
    if (fk.onUpdate !== relation.onUpdate) {
      deltas.push(`ON UPDATE declared ${relation.onUpdate}, database has ${fk.onUpdate}`);
    }
    if (deltas.length === 0) continue;

    counts.referentialActionDrifts += 1;
    findings.push({
      kind: 'referential-action',
      table: model.table,
      columns,
      model: model.name,
      field: relation.field,
      declared: `ON DELETE ${relation.onDelete} ON UPDATE ${relation.onUpdate}`,
      actual: `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`,
      detail: `${fk.name}: ${deltas.join('; ')}${
        relation.onDeleteExplicit
          ? ''
          : ` (onDelete not written; Prisma defaults a ${
              relation.optional ? 'optional' : 'required'
            } relation to ${relation.onDelete})`
      }`,
    });
  }
}

function checkNullability(
  model: ParsedModel,
  live: CatalogIndex,
  counts: DriftCounts,
  findings: DriftFinding[]
): void {
  for (const field of model.fields) {
    if (!field.scalar || field.list) continue;
    const notNull = live.columns.get(key([model.table, field.column]));
    // Column absent from the catalog: a missing column is its own defect class and is not
    // what this check is about, so it is left alone rather than reported as nullability.
    if (notNull === undefined) continue;

    counts.columnsChecked += 1;
    const declaredRequired = !field.optional;
    if (declaredRequired === notNull) continue;

    counts.nullabilityDrifts += 1;
    findings.push({
      kind: 'nullability',
      table: model.table,
      columns: [field.column],
      model: model.name,
      field: field.name,
      declared: declaredRequired ? 'required' : 'optional',
      actual: notNull ? 'NOT NULL' : 'NULLABLE',
    });
  }
}

function checkUniqueness(
  model: ParsedModel,
  live: CatalogIndex,
  counts: DriftCounts,
  findings: DriftFinding[]
): void {
  for (const unique of model.uniques) {
    const columns = unique.fields.map((f) => columnFor(model, f) ?? f);
    // If a column of the declaration is not in the table at all, the real drift is a
    // missing column, not a missing index. Out of scope; skip rather than mislabel.
    if (columns.some((c) => !live.columns.has(key([model.table, c])))) continue;

    counts.uniqueDeclarationsChecked += 1;
    if (live.uniqueIndexes.has(key([model.table, ...columns]))) continue;

    counts.uniquenessDrifts += 1;
    findings.push({
      kind: 'uniqueness',
      table: model.table,
      columns,
      model: model.name,
      field: unique.source === '@unique' ? unique.fields[0] : undefined,
      declared: `${unique.source}(${unique.fields.join(', ')})`,
      actual: 'no total unique index on these columns',
      detail:
        'partial (WHERE-clause) unique indexes are not counted; they do not enforce ' +
        'the declaration for every row',
    });
  }
}
