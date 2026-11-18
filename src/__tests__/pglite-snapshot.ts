import { PGlite, type PGliteOptions } from '@electric-sql/pglite';

const dumps = new Map<string, Promise<File | Blob>>();

/**
 * A fresh PGlite whose data directory is a copy of one built ONCE per `key` in this process.
 *
 * Booting a PGlite and replaying migrations into it costs most of a PGlite test's time, and many
 * test files did it for every test. Here the first call for a `key` builds a database with `build`,
 * dumps its data directory, and every call (the first included) loads its own copy of that dump.
 * Each test still gets its own independent database: a copy shares nothing with the template or
 * with other copies. The same pattern as `platform-feedback.service.test.ts`'s snapshot.
 *
 * What a copy does NOT carry: SESSION state (`SET TIME ZONE`, `SET ROLE`,
 * `session_replication_role`), which belongs to the connection that set it, not to the data
 * directory. Apply it to each copy. `options` (parsers, extensions) are passed to every copy.
 *
 * Vitest runs each test file in its own process (`isolate: true`), so the cache is per file.
 */
export async function pgliteFromSnapshot(
  key: string,
  build: (db: PGlite) => Promise<void>,
  options: PGliteOptions = {}
): Promise<PGlite> {
  let dump = dumps.get(key);
  if (!dump) {
    dump = (async () => {
      const template = new PGlite(options);
      try {
        await build(template);
        // Without it the dump replays WAL on load and each sequence resumes up to 32 values
        // ahead (measured in platform-feedback.service.test.ts).
        await template.exec('CHECKPOINT');
        return await template.dumpDataDir('none');
      } finally {
        await template.close();
      }
    })();
    dumps.set(key, dump);
    // A failed build is not cached: the next call builds again and reports its own error.
    dump.catch(() => dumps.delete(key));
  }
  return PGlite.create({ ...options, loadDataDir: await dump });
}
