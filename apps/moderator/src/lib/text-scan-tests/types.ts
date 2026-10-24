import type { LabEntityType, LabField } from '../text-scan-lab/types';
import type { Expected } from './expected';

export const WORKSPACES = ['prompts'] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const WORKSPACE_PATHS: Record<Workspace, string> = {
  prompts: '/text-scan/prompts',
};

export const WORKSPACE_NAMES: Record<Workspace, string> = {
  prompts: 'Prompts',
};

export const CASE_ORIGINS = ['try', 'matches', 'import'] as const;
export type CaseOrigin = (typeof CASE_ORIGINS)[number];

export const RUN_STATUSES = [
  'queued',
  'running',
  'cancelling',
  'done',
  'cancelled',
  'failed',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
  'cancelling',
] as const satisfies readonly RunStatus[];
export const CANCELLABLE_RUN_STATUSES = [
  'queued',
  'running',
] as const satisfies readonly RunStatus[];
export const isActiveRun = (status: string) =>
  (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
/** A cancelling run is already stopping. */
export const isCancellable = (status: string) =>
  (CANCELLABLE_RUN_STATUSES as readonly string[]).includes(status);
export type RunKind = 'baseline' | 'draft';
export const RUN_KIND_NAMES: Record<RunKind, string> = { baseline: 'Baseline', draft: 'Draft' };
export const RUN_POLL_MS = 4000;

export const TEST_SET_LIMITS = {
  nameChars: 100,
  descriptionChars: 2000,
  noteChars: 1000,
  sourceRefChars: 200,
  casesPerRun: 500,
  activeStarts: 3,
  chunk: 8,
  quoteSample: 8,
  leaseStaleMs: 5 * 60_000,
  draftRetentionDays: 90,
  recentRuns: 5,
} as const;

export type SetOption = { id: number; name: string; caseCount: number };

export type TestSet = {
  id: number;
  name: string;
  description: string | null;
  workspace: Workspace;
  createdBy: number;
  createdAt: Date;
  archivedAt: Date | null;
};

export type TestCase = {
  id: number;
  setId: number;
  entityType: LabEntityType;
  entityId: number | null;
  authorId: number | null;
  sourceRef: string | null;
  fields: LabField[] | null;
  textHash: string;
  expected: Expected;
  note: string | null;
  origin: CaseOrigin;
  sourceDeletedAt: Date | null;
  addedBy: number;
  addedAt: Date;
  updatedBy: number;
  updatedAt: Date;
};
