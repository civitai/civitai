import type { PGliteOptions } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { closeFileScoped, closeTestScoped, enterTest } from './pglite-tracker';

// Close every PGlite a unit test opens: at the end of the test that created it, or at the end of
// the file for one created outside any test. See pglite-tracker.ts for why, and for
// `keepPgliteForFile`.
//
// The class is replaced for every importer (test files, harnesses and app code alike), so no
// call site changes. `create` is redefined rather than inherited because the package's own
// `create` constructs its internal class, which would bypass the tracking and `instanceof`.
vi.mock('@electric-sql/pglite', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@electric-sql/pglite')>();
  const { trackPglite } = await import('./pglite-tracker');
  class PGlite extends mod.PGlite {
    constructor(dataDirOrOptions?: string | PGliteOptions, options?: PGliteOptions) {
      super(dataDirOrOptions as string, options);
      trackPglite(this);
    }

    static override async create(dataDirOrOptions?: string | PGliteOptions, options?: PGliteOptions) {
      const opts =
        typeof dataDirOrOptions === 'string'
          ? { dataDir: dataDirOrOptions, ...(options ?? {}) }
          : dataDirOrOptions ?? {};
      const db = new PGlite(opts);
      await db.waitReady;
      return db as never;
    }

    // Idempotent, unlike the package's (which throws "PGlite is closed"): files that close the
    // PREVIOUS test's instance in their next `beforeEach` (`await db?.close()`), or close in
    // `afterAll`, find it already closed by the hook below.
    override async close() {
      if (this.closed) return;
      await super.close();
    }

    override async clone() {
      const copy = await super.clone();
      trackPglite(copy);
      return copy;
    }
  }

  return { ...mod, PGlite };
});

// Registered before any test file's own hooks, so (Vitest's default `stack` hook order) this
// `beforeEach` runs first and this `afterEach` / `afterAll` run LAST — after a file's own
// cleanup, which may already have closed what it opened.
beforeEach(() => enterTest());
afterEach(async () => {
  await closeTestScoped();
});
afterAll(async () => {
  await closeFileScoped();
});
