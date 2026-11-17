import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';

type Entry = { Key: string; VersionId: string; deleteMarker: boolean };

const MAX_LISTS = 50;

/**
 * A versioned bucket as S3 and B2 behave: a delete by key alone adds a delete marker and keeps every
 * version; only a delete naming a VersionId removes one. Listing pages by (KeyMarker, VersionIdMarker).
 */
export function fakeVersionedBucket({ pageSize = 1000 }: { pageSize?: number } = {}) {
  let entries: Entry[] = [];
  let seq = 0;
  const pinned = new Set<string>();
  const calls: string[] = [];

  const add = (Key: string, deleteMarker = false) => {
    // Newest first within a key, as a listing returns them.
    entries = [{ Key, VersionId: `v${++seq}`, deleteMarker }, ...entries];
  };
  const sorted = () => [...entries].sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));

  function list(input: ListObjectVersionsCommand['input']) {
    const all = sorted().filter((e) => e.Key.startsWith(input.Prefix ?? ''));
    let start = 0;
    if (input.KeyMarker) {
      const at = input.VersionIdMarker
        ? all.findIndex((e) => e.Key === input.KeyMarker && e.VersionId === input.VersionIdMarker)
        : all.filter((e) => e.Key <= input.KeyMarker!).length - 1;
      start = at + 1;
    }
    const page = all.slice(start, start + pageSize);
    const truncated = start + pageSize < all.length;
    const last = page[page.length - 1];
    return {
      Versions: page
        .filter((e) => !e.deleteMarker)
        .map(({ Key, VersionId }) => ({ Key, VersionId })),
      DeleteMarkers: page
        .filter((e) => e.deleteMarker)
        .map(({ Key, VersionId }) => ({ Key, VersionId })),
      IsTruncated: truncated,
      NextKeyMarker: truncated ? last.Key : undefined,
      NextVersionIdMarker: truncated ? last.VersionId : undefined,
    };
  }

  function deleteOne(Key: string, VersionId?: string) {
    if (VersionId && pinned.has(Key)) return {};
    if (VersionId) entries = entries.filter((e) => !(e.Key === Key && e.VersionId === VersionId));
    else add(Key, true);
    return {};
  }

  async function send(command: unknown) {
    if (command instanceof ListObjectVersionsCommand) {
      calls.push('list');
      // A caller that drops the paging markers would list page 1 forever, in microtasks no test
      // timeout interrupts: fail instead.
      if (calls.filter((c) => c === 'list').length > MAX_LISTS)
        throw new Error(`fake bucket: more than ${MAX_LISTS} listings; are the markers passed on?`);
      return list(command.input);
    }
    if (command instanceof DeleteObjectCommand) {
      calls.push(command.input.VersionId ? 'delete-version' : 'delete-key');
      return deleteOne(command.input.Key!, command.input.VersionId);
    }
    if (command instanceof DeleteObjectsCommand) {
      calls.push('delete-many');
      for (const o of command.input.Delete?.Objects ?? []) deleteOne(o.Key!, o.VersionId);
      return {};
    }
    throw new Error(`fake bucket: unexpected ${(command as object).constructor.name}`);
  }

  return {
    send,
    calls,
    putVersion: (key: string) => add(key),
    putDeleteMarker: (key: string) => add(key, true),
    /** Every version and delete marker stored under exactly this key. */
    entriesFor: (key: string) => entries.filter((e) => e.Key === key),
    /** Version deletes of `key` answer success and remove nothing, like a store that keeps them. */
    pinVersions: (key: string) => pinned.add(key),
  };
}
