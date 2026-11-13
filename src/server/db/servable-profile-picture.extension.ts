import { Prisma } from '@prisma/client';
import { servableProfilePicture } from '~/server/services/profile-picture.servable';

/**
 * A user's `profilePicture`, read through Prisma's nested select (`simpleUserSelect` and every copy
 * of it), comes back as `null` unless `servableProfilePicture` serves it: Scanned and not flagged
 * `csam`. Stricter than `servableProfilePictureSql`, which also admits moderator-locked ratings.
 * `User.profilePicture` is the only relation of that name, so the match is by key: a spread or
 * hand-built copy of the select is caught too.
 *
 * Only find queries are touched; writes return what they wrote. A query whose select tree has no
 * `profilePicture` carrying `url` is passed through as is: the cost is one walk of the args.
 */

const READ_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
] as const;

const PICTURE_KEY = 'profilePicture';

type Args = Record<string, unknown>;
const CHECKED_FIELDS = ['ingestion', 'needsReview'] as const;
type CheckedField = (typeof CHECKED_FIELDS)[number];
type Leaf = { added: CheckedField[] };
type Plan = Map<string, Plan | Leaf>;

const isObject = (value: unknown): value is Args =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pictureLeaf(value: unknown): Leaf | undefined {
  if (value === true) return { added: [] };
  if (!isObject(value)) return undefined;
  const select = value.select;
  if (isObject(select)) {
    if (!select.url) return undefined;
    return { added: CHECKED_FIELDS.filter((field) => !select[field]) };
  }
  const omit = value.omit;
  return { added: isObject(omit) ? CHECKED_FIELDS.filter((field) => omit[field]) : [] };
}

export function planProfilePictures(args: unknown): Plan | undefined {
  if (!isObject(args)) return undefined;
  let plan: Plan | undefined;
  for (const tree of [args.select, args.include]) {
    if (!isObject(tree)) continue;
    for (const [key, value] of Object.entries(tree)) {
      const node = key === PICTURE_KEY ? pictureLeaf(value) : planProfilePictures(value);
      if (node) (plan ??= new Map()).set(key, node);
    }
  }
  return plan;
}

/** `args` with each leaf's `added` fields selected (or un-omitted), copied along those paths only. */
function withIngestion(args: Args, plan: Plan): Args {
  const copy: Args = { ...args };
  for (const treeKey of ['select', 'include'] as const) {
    const tree = args[treeKey];
    if (!isObject(tree)) continue;
    let treeCopy: Args | undefined;
    for (const [key, node] of plan) {
      if (!(key in tree)) continue;
      const value = tree[key];
      let next: unknown = value;
      if (node instanceof Map) next = withIngestion(value as Args, node);
      else if (node.added.length) {
        const relation = value as Args;
        const fields = Object.fromEntries(node.added.map((field) => [field, true]));
        next = isObject(relation.select)
          ? { ...relation, select: { ...relation.select, ...fields } }
          : {
              ...relation,
              omit: {
                ...(relation.omit as Args),
                ...Object.fromEntries(node.added.map((f) => [f, false])),
              },
            };
      }
      if (next !== value) (treeCopy ??= { ...tree })[key] = next;
    }
    if (treeCopy) copy[treeKey] = treeCopy;
  }
  return copy;
}

function needsIngestion(plan: Plan): boolean {
  for (const node of plan.values())
    if (node instanceof Map ? needsIngestion(node) : node.added.length) return true;
  return false;
}

export function applyProfilePicturePlan(result: unknown, plan: Plan): void {
  if (Array.isArray(result)) {
    for (const row of result) applyProfilePicturePlan(row, plan);
    return;
  }
  if (!isObject(result)) return;
  for (const [key, node] of plan) {
    if (node instanceof Map) {
      applyProfilePicturePlan(result[key], node);
      continue;
    }
    const picture = result[key];
    if (!isObject(picture)) continue;
    if (
      !servableProfilePicture(
        picture as { ingestion: string | null },
        picture.needsReview as string | null
      )
    )
      result[key] = null;
    else for (const field of node.added) delete picture[field];
  }
}

/** The fallback when the plan fails: every `profilePicture` anywhere in the result becomes null. */
function nullEveryProfilePicture(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) nullEveryProfilePicture(item, seen);
    return;
  }
  const record = value as Args;
  for (const key of Object.keys(record)) {
    if (key === PICTURE_KEY) record[key] = null;
    else nullEveryProfilePicture(record[key], seen);
  }
}

export type ProfilePictureGateError = (error: unknown) => void;

/**
 * One find query through the gate. The query's own errors propagate; an error in the gate itself
 * is reported to `onError` and nulls every picture in the result instead.
 */
export async function gateProfilePictures<T>(
  args: unknown,
  query: (args: unknown) => Promise<T>,
  onError: ProfilePictureGateError
): Promise<T> {
  let plan: Plan | undefined;
  let queryArgs = args;
  try {
    plan = planProfilePictures(args);
    if (plan && needsIngestion(plan)) queryArgs = withIngestion(args as Args, plan);
  } catch (error) {
    onError(error);
    const result = await query(args);
    nullEveryProfilePicture(result);
    return result;
  }
  if (!plan) return query(args);

  const result = await query(queryArgs);
  try {
    applyProfilePicturePlan(result, plan);
  } catch (error) {
    onError(error);
    try {
      nullEveryProfilePicture(result);
    } catch (fallbackError) {
      onError(fallbackError);
    }
  }
  return result;
}

export const servableProfilePictureExtension = (onError: ProfilePictureGateError) =>
  Prisma.defineExtension({
    name: 'servable-profile-picture',
    query: {
      $allModels: Object.fromEntries(
        READ_OPERATIONS.map((operation) => [
          operation,
          ({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) =>
            gateProfilePictures(args, query, onError),
        ])
      ),
    },
  });

type ExtendableClient = { $extends: (extension: never) => unknown };

/**
 * `clients` with the extension applied to each. A single client serving both reads and writes
 * stays a single client.
 */
export function withServableProfilePictures<C extends ExtendableClient>(
  clients: { dbRead: C; dbWrite: C },
  onError: ProfilePictureGateError
): { dbRead: C; dbWrite: C } {
  const extension = servableProfilePictureExtension(onError);
  // The extended client's type is not the base client's; every call site uses the same API.
  const extend = (client: C) => client.$extends(extension as never) as C;
  const dbWrite = extend(clients.dbWrite);
  const dbRead = clients.dbRead === clients.dbWrite ? dbWrite : extend(clients.dbRead);
  return { dbRead, dbWrite };
}
