/** Whether two URLs name the same blob. Sample URLs are presigned, and the orchestrator re-mints the
 *  signature query on every read of the run — so only origin + path identify the file. */
export function sameBlob(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}
