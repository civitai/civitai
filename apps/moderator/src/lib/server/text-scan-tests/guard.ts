import { error, fail } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import { canAccess } from '$lib/server/access';
import type { DB as ModeratorDB } from '$lib/server/moderator-db/types';
import { int4Id } from '$lib/server/query';
import { LabError } from '$lib/server/text-scan-lab/errors';
import { isInt4Id } from '$lib/server/users.service';
import {
  WORKSPACE_NAMES,
  WORKSPACE_PATHS,
  WORKSPACES,
  type TestSet,
  type Workspace,
} from '$lib/text-scan-tests/types';
import { TestSetError, requireSet } from './store';

type User = Parameters<typeof canAccess>[0];

export const idField = int4Id;
const cannotOpen = (workspace: Workspace) =>
  `This set belongs to ${WORKSPACE_NAMES[workspace]}, which you cannot open.`;

const isWorkspace = (value: string): value is Workspace =>
  (WORKSPACES as readonly string[]).includes(value);

export const canOpenWorkspace = (user: User, workspace: Workspace) =>
  canAccess(user, WORKSPACE_PATHS[workspace]);

/** A set stored under a retired workspace (Model rules) is not found, not merely forbidden. */
export function requireWorkspace(user: User, workspace: Workspace): void {
  if (!isWorkspace(workspace)) throw new TestSetError('Test set not found.', 404);
  if (!canOpenWorkspace(user, workspace)) throw new TestSetError(cannotOpen(workspace), 403);
}

export function refusal(e: unknown) {
  if (e instanceof TestSetError || e instanceof LabError)
    return fail(e.status, { error: e.message });
  throw e;
}

/** For loads and GET endpoints, where a refusal is an error page rather than a form failure. */
export function viewError(e: unknown): never {
  if (e instanceof TestSetError) error(e.status, e.message);
  throw e;
}

export function routeId(raw: string): number {
  const id = Number(raw);
  if (!isInt4Id(id)) error(404, 'Not found.');
  return id;
}

export async function setForView(
  db: Kysely<ModeratorDB>,
  user: User,
  setId: number
): Promise<TestSet> {
  try {
    const set = await requireSet(db, setId);
    requireWorkspace(user, set.workspace);
    return set;
  } catch (e) {
    viewError(e);
  }
}
