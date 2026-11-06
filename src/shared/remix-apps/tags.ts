/**
 * The workflow tags a remix run is stored in. A run has no row of its own: its segments are
 * workflows sharing a `remix-run:<id>` tag, and its tray state is a tag on the latest one.
 */
export const REMIX_APP_TAG = 'remix-app';
export const REMIX_DONE_TAG = 'remix:done';
export const REMIX_DISMISSED_TAG = 'remix:dismissed';
export const REMIX_RUN_TAG_PREFIX = 'remix-run:';
export const REMIX_SEGMENT_TAG_PREFIX = 'remix-seg:';

export const remixAppTag = (slug: string) => `${REMIX_APP_TAG}:${slug}`;

export function readRemixTag(tags: readonly string[] | undefined, prefix: string) {
  return tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

/** The tags on segment `segment` of run `runId`: what the tray and `readRun` find it by. */
export function remixRunTags({
  slug,
  runId,
  segment,
}: {
  slug: string;
  runId: string;
  segment: number;
}) {
  return [
    REMIX_APP_TAG,
    remixAppTag(slug),
    REMIX_RUN_TAG_PREFIX + runId,
    REMIX_SEGMENT_TAG_PREFIX + segment,
  ];
}
