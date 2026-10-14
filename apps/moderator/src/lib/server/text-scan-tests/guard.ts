import { error, fail } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { canAccess } from '$lib/server/access';
import type { DB as ModeratorDB } from '$lib/server/moderator-db/types';
import { LabError } from '$lib/server/text-scan-lab/errors';
import { MAX_INT4, isInt4Id } from '$lib/server/users.service';
import {
  WORKSPACE_NAMES,
  WORKSPACE_PATHS,
  type TestSet,
  type Workspace,
} from '$lib/text-scan-tests/types';
import { TestSetError, requireSet } from './store';

type User = Parameters<typeof canAccess>[0];

export const idField = z.coerce.number().int().positive().max(MAX_INT4);
const cannotOpen = (workspace: Workspace) =>
  `This set belongs to ${WORKSPACE_NAMES[workspace]}, which you cannot open.`;

export const canOpenWorkspace = (user: User, workspace: Workspace) =>
  canAccess(user, WORKSPACE_PATHS[workspace]);

export function requireWorkspace(user: User, workspace: Workspace): void {
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
