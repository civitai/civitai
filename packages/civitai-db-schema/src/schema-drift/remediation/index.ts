export {
  buildRemediationPlan,
  planStatements,
  relationKey,
  strategyForAction,
  writingStatements,
  DEFAULT_BACKUP_SCHEMA,
  DEFAULT_BATCH_SIZE,
} from './plan';
export { EXCLUSIONS, EXCLUDED_RANK_KEYS, findExclusion } from './exclusions';
export type { Exclusion } from './exclusions';
export { RemediationRefused, countOrphans, executePlan, DEFAULT_MAX_BATCHES } from './execute';
export type { ExecuteOptions, ExecutionResult, RelationExecution } from './execute';
export { readIndexes } from './catalog-indexes';
export { formatPlan } from './report';
export type { FormatOptions } from './report';
export {
  MAX_IDENTIFIER_BYTES,
  addConstraintNotValidSql,
  backupTableNameFor,
  constraintNameFor,
  countOrphansSql,
  createBackupSchemaSql,
  createBackupTableSql,
  createIndexConcurrentlySql,
  deleteOrphanBatchSql,
  identifierBytes,
  indexNameFor,
  nullOrphanBatchSql,
  quoteIdent,
  quoteQualified,
  sqlAction,
  validateConstraintSql,
} from './sql';
export type { RelationSqlContext } from './sql';
export type {
  CatalogIndexEntry,
  IndexCoverage,
  PlanCounts,
  PlanOptions,
  PlanOutcome,
  PlannedStatement,
  Prerequisite,
  PrerequisiteCode,
  Refusal,
  RefusalCode,
  RelationPlan,
  RemediationCatalog,
  RemediationPlan,
  RemediationStrategy,
  StatementKind,
} from './types';
