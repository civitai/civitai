/**
 * Shared types for the schema<->database drift detector.
 *
 * Everything here is plain data so the parser, the catalog reader and the differ can be
 * exercised independently — the differ never touches a database, and the catalog reader
 * never reads the schema.
 */

/** Prisma's referential-action vocabulary. */
export type ReferentialAction = 'Cascade' | 'Restrict' | 'NoAction' | 'SetNull' | 'SetDefault';

export const REFERENTIAL_ACTIONS: readonly ReferentialAction[] = [
  'Cascade',
  'Restrict',
  'NoAction',
  'SetNull',
  'SetDefault',
];

/**
 * Postgres encodes referential actions as a single char in
 * `pg_constraint.confdeltype` / `.confupdtype`.
 *
 * NOTE `NoAction` and `Restrict` are genuinely different codes, not synonyms: both reject
 * the parent row change, but NO ACTION defers the check to end-of-statement (and can be
 * `DEFERRABLE`), RESTRICT checks immediately. Prisma emits them distinctly, so a mismatch
 * between the two is reported rather than folded together.
 */
export const PG_ACTION_CODES: Record<string, ReferentialAction> = {
  a: 'NoAction',
  r: 'Restrict',
  c: 'Cascade',
  n: 'SetNull',
  d: 'SetDefault',
};

// ---------------------------------------------------------------------------
// Parsed Prisma schema
// ---------------------------------------------------------------------------

export interface ParsedField {
  /** Field name as written in the schema. */
  name: string;
  /** Database column: the `@map("...")` argument, else the field name. */
  column: string;
  /** Base type with `?` / `[]` stripped (`Int`, `String`, `User`, `MediaType`, ...). */
  type: string;
  /** Declared with a trailing `?`. */
  optional: boolean;
  /** Declared with a trailing `[]`. */
  list: boolean;
  /** One of Prisma's scalar types (as opposed to a model or enum reference). */
  scalar: boolean;
  /** Carries a field-level `@unique`. */
  unique: boolean;
}

export interface ParsedRelation {
  /** Owning model name. */
  model: string;
  /** Owning relation field name (`image`, `createdBy`, ...). */
  field: string;
  /** Referenced model name, as written (`Image`, `User`, ...). */
  targetModel: string;
  /** `@relation(fields: [...])` — Prisma field names on the owning model, in order. */
  fields: string[];
  /** `@relation(references: [...])` — Prisma field names on the target model, in order. */
  references: string[];
  /**
   * Effective `onDelete`, with Prisma's default applied when unwritten.
   *
   * The default is NOT `Cascade`: an optional relation defaults to `SetNull`, a required
   * one to `Restrict`. Reading a bare relation as a cascade is how a `Restrict` that would
   * reject every parent delete gets mis-tiered as a cascade-delete risk.
   */
  onDelete: ReferentialAction;
  /** Effective `onUpdate`; Prisma's default is `Cascade` for both optional and required. */
  onUpdate: ReferentialAction;
  /** Whether `onDelete` was written out, as opposed to defaulted. */
  onDeleteExplicit: boolean;
  /** Whether `onUpdate` was written out, as opposed to defaulted. */
  onUpdateExplicit: boolean;
  /** Relation field declared with a trailing `?`. Drives the `onDelete` default. */
  optional: boolean;
}

export interface ParsedUnique {
  /** Prisma field names, in declaration order. */
  fields: string[];
  source: '@unique' | '@@unique';
}

export interface ParsedModel {
  name: string;
  /** `@@map("...")` argument, else the model name. */
  table: string;
  /** Model carries `@@ignore`; Prisma does not manage it, so neither do we. */
  ignored: boolean;
  fields: ParsedField[];
  uniques: ParsedUnique[];
  relations: ParsedRelation[];
}

export interface ParsedSchema {
  models: ParsedModel[];
}

// ---------------------------------------------------------------------------
// Database catalog
// ---------------------------------------------------------------------------

export interface CatalogColumn {
  table: string;
  column: string;
  /**
   * `pg_attribute.attnotnull`.
   *
   * Named with underscores on purpose. `NOTNULL` is a reserved word in Postgres, so
   * `SELECT a.attnotnull notnull` parses as the *postfix* `IS NOT NULL` operator applied to
   * `attnotnull` and yields a constant `true` for every row — a silent, one-directional
   * fabrication of "schema says optional, database says NOT NULL" drift.
   * `assertCatalogSanity` below is the standing guard against that class.
   */
  notNull: boolean;
}

export interface CatalogForeignKey {
  /** Constraint name, for reporting. */
  name: string;
  table: string;
  /** Constrained columns in constraint order (`conkey` order, not alphabetical). */
  columns: string[];
  refTable: string;
  /** Referenced columns in `confkey` order. */
  refColumns: string[];
  /**
   * Decoded `confdeltype` / `confupdtype`. `null` means the catalog snapshot did not
   * carry the field — the action check is then skipped rather than guessed.
   */
  onDelete: ReferentialAction | null;
  onUpdate: ReferentialAction | null;
  /**
   * `pg_constraint.convalidated`.
   *
   * 🔴 A foreign key added `NOT VALID` is PRESENT but only half-enforcing: it constrains
   * new and changed rows and has never checked the ones already there. Every catalog read
   * that filters on `contype = 'f'` alone reports it as an ordinary foreign key, so a run
   * that died between `ADD CONSTRAINT` and `VALIDATE CONSTRAINT` looks, to the next run,
   * exactly like a finished one. That is not a hypothetical: `VALIDATE CONSTRAINT` scans
   * the whole table, and a statement timeout will end it on the large tables.
   *
   * `null` means the catalog snapshot did not carry the field, which is NOT the same as
   * `true` — consumers must not read an absent value as validated.
   */
  validated: boolean | null;
}

export interface CatalogUniqueIndex {
  table: string;
  /** Key columns in index order. Partial (`indpred`) indexes are excluded upstream. */
  columns: string[];
}

export interface DbCatalog {
  /**
   * ISO-8601 instant the catalog was captured, stamped by `--dump-catalog`.
   *
   * Optional because captures predating the field exist. A CONSUMER OF A CAPTURED CATALOG
   * MUST TREAT ITS ABSENCE AS A PROBLEM, not as a default: a frozen catalog's age determines
   * how much of the schema a comparison against it can still say anything sharp about, and
   * without a date that decay is invisible. `snapshotAge` in `gate.ts` is the guard.
   */
  capturedAt?: string;
  /** Ordinary + partitioned tables. Views are listed separately, in `views`. */
  tables: string[];
  /**
   * Views and materialised views, so a model mapped to one can be told apart from a model
   * mapped to a table that is not there at all.
   *
   * ABSENT IS NOT EMPTY, and the differ must not read it as one. Until this field existed
   * both cases arrived as the same thing — "no table of that name" — and both were skipped
   * wholesale with the reason "view, or absent". A model on a view is correctly unmanaged;
   * a model on a nothing is drift, and the larger the drift the quieter the tool got. A
   * snapshot captured before this field carries `undefined`, which means unclassifiable, and
   * the differ degrades to the old lumped reason rather than accusing 23 views of being
   * missing tables.
   */
  views?: string[];
  columns: CatalogColumn[];
  foreignKeys: CatalogForeignKey[];
  uniqueIndexes: CatalogUniqueIndex[];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type DriftKind =
  | 'missing-foreign-key'
  | 'referential-action'
  | 'missing-column'
  | 'missing-table'
  | 'nullability'
  | 'uniqueness';

export interface DriftFinding {
  kind: DriftKind;
  /** Database table the finding is about. */
  table: string;
  /** Database columns the finding is about, in declaration order. */
  columns: string[];
  /** Prisma model name. */
  model: string;
  /** Prisma field name, where the finding is about a single field. */
  field?: string;
  /** What the schema declares. */
  declared: string;
  /** What the database actually has. */
  actual: string;
  /** Extra context (referenced table, constraint name, ...). */
  detail?: string;
}

export interface SkippedRelation {
  model: string;
  table: string;
  field: string;
  reason: string;
}

/**
 * Why a model was skipped, as a value rather than as prose.
 *
 * `unclassified` is the one that matters: it means the snapshot carries no `views` list, so
 * `view` and `absent` could not be told apart. Counting it as either would be a guess.
 */
export type SkipClassification = 'ignored' | 'view' | 'absent' | 'unclassified';

export interface SkippedModel {
  model: string;
  table: string;
  classification: SkipClassification;
  reason: string;
}

export interface DriftCounts {
  /** Owning-side `@relation(fields: ..., references: ...)` declarations found in the schema. */
  declaredRelations: number;
  /** Of those, the ones on a model whose table exists and is managed. */
  relationsChecked: number;
  /** Of those, the ones skipped (model `@@ignore`d, or table absent — e.g. a view). */
  relationsSkipped: number;
  missingForeignKeys: number;
  /** FKs present but with a different `ON DELETE` / `ON UPDATE` than declared. */
  referentialActionDrifts: number;
  /** FKs present whose action could not be compared (snapshot carried no action data). */
  referentialActionUnknown: number;
  /** Scalar columns compared for nullability (only those the catalog actually has). */
  columnsChecked: number;
  /** Scalar fields whose column is absent from the table entirely. */
  missingColumns: number;
  /** Models whose table is neither a table nor a view in the catalog. */
  missingTables: number;
  /** Models skipped because the snapshot could not say whether the table is a view. */
  modelsUnclassified: number;
  nullabilityDrifts: number;
  uniqueDeclarationsChecked: number;
  uniquenessDrifts: number;
}

export interface DriftReport {
  counts: DriftCounts;
  findings: DriftFinding[];
  skippedRelations: SkippedRelation[];
  skippedModels: SkippedModel[];
}
