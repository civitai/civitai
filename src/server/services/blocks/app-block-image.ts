/**
 * The canonical immutable image the pipeline pushes for an approved on-site app build:
 * `ghcr.io/civitai/app-block-<slug>:<sha>`. One spelling, shared by the build callback (which
 * binds an accepted callback's imageRef to it) and the live restore (which re-publishes it).
 */
export function liveAppImageRef(slug: string, sha: string): string {
  return `ghcr.io/civitai/app-block-${slug}:${sha}`;
}
