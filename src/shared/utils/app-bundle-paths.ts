/**
 * Whether `civitai app submit` leaves `rel` (a path inside the app) out of its package, for what the
 * sandbox export lets through: the root `scratch/` folder (throwaway probes) and any `*.zip` (a
 * package an earlier `app submit` wrote), as the CLI's packager (`pkgzip`) drops them.
 *
 * Shared by App Assistant's Submit for review (the page) and the source-repo writer (the server),
 * so a file one leaves out the other leaves out too.
 */
export function cliLeavesOut(rel: string): boolean {
  return rel.startsWith('scratch/') || rel.toLowerCase().endsWith('.zip');
}
