/**
 * Which PGlite instances the current test file has opened, and when each one closes.
 *
 * Every PGlite a unit test constructs (`new PGlite()`, `PGlite.create()`, `.clone()`) is
 * registered here by the module mock in `pglite-close-on-finish.ts`, and closed for the test:
 *
 *  - created while a test is running (its body, or a `beforeEach`) — closed when THAT test
 *    finishes, after the file's own `afterEach` hooks;
 *  - created anywhere else (module scope, `beforeAll`) — shared by the file's tests, and closed
 *    when the file finishes.
 *
 * Why: most PGlite tests never close what they open, so every instance a file created stayed
 * alive (each a full WebAssembly Postgres) until the file's process exited. On the unit shard
 * that runs the heaviest PGlite files together, that held the runner at its memory limit, into
 * swap, and once past the job's time limit.
 *
 * A test that hands an instance it created to a LATER test keeps it with `keepPgliteForFile`.
 */

type Closable = { readonly closed: boolean; close(): Promise<void> };

let inTest = false;
const testScoped = new Set<Closable>();
const fileScoped = new Set<Closable>();

export function trackPglite(db: Closable): void {
  (inTest ? testScoped : fileScoped).add(db);
}

/** Keep an instance a test created open until the file ends, for a later test to use. */
export function keepPgliteForFile(db: Closable): void {
  testScoped.delete(db);
  fileScoped.add(db);
}

export function enterTest(): void {
  inTest = true;
}

async function closeAll(set: Set<Closable>): Promise<void> {
  for (const db of [...set]) {
    set.delete(db);
    if (db.closed) continue;
    try {
      await db.close();
    } catch {
      // An instance whose start-up failed rejects here; its test already reported that.
    }
  }
}

export async function closeTestScoped(): Promise<void> {
  inTest = false;
  await closeAll(testScoped);
}

export async function closeFileScoped(): Promise<void> {
  await closeAll(testScoped);
  await closeAll(fileScoped);
}

/** How many tracked instances are open right now (read by the guard test). */
export function openTrackedPglites(): number {
  return [...testScoped, ...fileScoped].filter((db) => !db.closed).length;
}
