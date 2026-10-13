import { error, fail } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import { canAccess } from '$lib/server/access';
import type { DB as ModeratorDB } from '$lib/server/moderator-db/types';
import { LabError } from '$lib/server/text-scan-lab/errors';
import {
  WORKSPACE_NAMES,
  WORKSPACE_PATHS,
  type TestSet,
  type Workspace,
} from '$lib/text-scan-tests/types';
import { TestSetError, getSet } from './store';

type User = Parameters<typeof canAccess>[0];

const MAX_INT4 = 2_147_483_647;
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

export function routeId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > MAX_INT4) error(404, 'Not found.');
  return id;
}

/** For loads and GET endpoints, where a refusal is an error page rather than a form failure. */
export async function setForView(
  db: Kysely<ModeratorDB>,
  user: User,
  setId: number
): Promise<TestSet> {
  const set = await getSet(db, setId);
  if (!set) error(404, 'Test set not found.');
  if (!canOpenWorkspace(user, set.workspace)) error(403, cannotOpen(set.workspace));
  return set;
}
