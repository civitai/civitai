import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { NAVIGATION, canAccess, isSuper } from '$lib/server/access';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { ownableQueues, retiredQueuePaths } from '$lib/queue-owners';
import { int4Id, jsonField, parseForm } from '$lib/server/query';
import {
  QueueOwnerConflictError,
  QueueOwnersUnavailableError,
  changeQueueOwners,
  listModeratorCandidates,
  listQueueOwnerChanges,
  listQueueOwners,
  queueOwnersUnavailableMessage,
} from '$lib/server/queue-owners';
import { usersByIds } from '$lib/server/users.service';

const RECENT_CHANGES = 50;
// Far above any real team, and it bounds what one save can ask the database to do.
const MAX_OWNERS_PER_QUEUE = 50;

// `/admin` admits only the admin role; each action checks again, so moving or regranting the page
// cannot widen who may assign work.
const isAdmin = (locals: App.Locals) => isSuper(locals.user);

export type OwnerView = {
  id: number;
  username: string | null;
  /** No longer a live moderator account: kept on the queue until someone removes them. */
  former: boolean;
  /** Owns the queue but cannot open it: their roles hold no grant for it. */
  noAccess: boolean;
};

export const load: PageServerLoad = async ({ locals }) => {
  if (!isAdmin(locals)) error(403, 'Admins only.');
  const [owners, changes] = await Promise.all([
    listQueueOwners(),
    listQueueOwnerChanges(RECENT_CHANGES),
  ]).catch((e) => {
    console.error('[admin] queue owners unavailable', e);
    error(503, queueOwnersUnavailableMessage(moderatorDbStatus(e)));
  });
  const moderators = await listModeratorCandidates();
  const byId = new Map(moderators.map((m) => [m.id, m]));

  // Owners and history actors who are no longer moderators still need a name.
  const strangers = [
    ...Object.values(owners).flat(),
    ...changes.flatMap((c) => [c.actorId, ...c.before, ...c.after]),
  ].filter((id) => !byId.has(id));
  const names = await usersByIds(strangers);
  const nameOf = (id: number) => byId.get(id)?.username ?? names.get(id)?.username ?? null;

  const view = (path: string) =>
    (owners[path] ?? []).map((id): OwnerView => {
      const moderator = byId.get(id);
      return {
        id,
        username: nameOf(id),
        former: !moderator,
        noAccess: !!moderator && !canAccess({ roles: moderator.roles }, path),
      };
    });

  const queues = ownableQueues(NAVIGATION);
  return {
    queues: queues.map((q) => ({ ...q, owners: view(q.path) })),
    retired: retiredQueuePaths(queues, owners).map((path) => ({ path, owners: view(path) })),
    moderators: moderators.map((m) => ({ id: m.id, username: m.username })),
    changes: changes.map((c) => ({
      ...c,
      actorName: nameOf(c.actorId),
      beforeNames: c.before.map((id) => nameOf(id) ?? `#${id}`),
      afterNames: c.after.map((id) => nameOf(id) ?? `#${id}`),
    })),
    wide: true,
  };
};

const ownerList = z.array(int4Id).max(MAX_OWNERS_PER_QUEUE, 'Too many owners on one queue.');
const saveSchema = z.object({
  changes: jsonField(z.record(z.string(), ownerList), 'Could not read the submitted changes.'),
  // Each changed queue's owners as the page showed them, so a save refuses rather than reverts a change
  // another admin made since.
  expect: jsonField(z.record(z.string(), ownerList), 'Could not read the submitted changes.'),
});

export const actions: Actions = {
  save: async ({ request, locals }) => {
    if (!isAdmin(locals)) return fail(403, { error: 'Admins only.' });
    const input = parseForm(saveSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const entries = Object.entries(input.changes).map(([path, owners]) => ({
      path,
      owners: [...new Set(owners)],
    }));
    if (!entries.length) return fail(400, { error: 'Nothing was changed.' });

    // The live queue set, plus stored paths that are no longer queues — which may only be emptied.
    const queues = new Set(ownableQueues(NAVIGATION).map((q) => q.path));
    for (const { path, owners } of entries) {
      if (!(path in input.expect))
        return fail(400, {
          error:
            'This page is out of date, so nothing was saved. Reload it and re-apply your changes.',
        });
      if (!queues.has(path) && owners.length)
        return fail(400, { error: `${path} is not a queue, so it cannot be given owners.` });
    }

    // Only owners being ADDED must be live moderators: a former one already on a queue is not
    // re-validated, or a queue could never be saved again until someone noticed and removed them.
    const added = new Set(
      entries.flatMap(({ path, owners }) =>
        owners.filter((id) => !(input.expect[path] ?? []).includes(id))
      )
    );
    if (added.size) {
      let moderators: Set<number>;
      try {
        moderators = new Set((await listModeratorCandidates()).map((m) => m.id));
      } catch (e) {
        console.error('[admin] could not read the moderator list', e);
        return fail(503, { error: 'Could not read the moderator list. Nothing was saved.' });
      }
      const outsiders = [...added].filter((id) => !moderators.has(id));
      if (outsiders.length)
        return fail(400, {
          error: `User ${outsiders
            .map((id) => `#${id}`)
            .join(', ')} is not a moderator, so nothing was saved.`,
        });
    }

    try {
      const { changed } = await changeQueueOwners({
        entries,
        expect: input.expect,
        actorId: locals.user.id,
      });
      return { success: true, count: changed };
    } catch (e) {
      if (e instanceof QueueOwnerConflictError)
        return fail(e.status, {
          error: `${e.message} Nothing was saved. Reload the page to see the current owners.`,
        });
      if (e instanceof QueueOwnersUnavailableError) return fail(e.status, { error: e.message });
      throw e;
    }
  },
};
