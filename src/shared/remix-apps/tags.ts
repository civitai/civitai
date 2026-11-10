/**
 * The workflow tags a remix run is stored in. A run has no row of its own: its segments are
 * workflows sharing a `remix-run:<id>` tag, and its tray state is a tag on the latest one.
 */
export const REMIX_APP_TAG = 'remix-app';
export const REMIX_DONE_TAG = 'remix:done';
export const REMIX_DISMISSED_TAG = 'remix:dismissed';
export const REMIX_RUN_TAG_PREFIX = 'remix-run:';
export const REMIX_SEGMENT_TAG_PREFIX = 'remix-seg:';
/** On a segment `remixApp.advance` continues; a one-shot run (the team remix) has none. */
export const REMIX_RUNTIME_TAG = 'remix:runtime';
/** Apps that ran on the runtime before it tagged its segments: their untagged runs advance too. */
const UNTAGGED_RUNTIME_SLUGS = new Set(['anime-it', 'pick-of-four', 'restyle']);

/** Whether the run whose latest segment carries `tags` continues through `remixApp.advance`. */
export function isRuntimeRun(slug: string, tags: readonly string[]) {
  return tags.includes(REMIX_RUNTIME_TAG) || UNTAGGED_RUNTIME_SLUGS.has(slug);
}

export const remixAppTag = (slug: string) => `${REMIX_APP_TAG}:${slug}`;

export function readRemixTag(tags: readonly string[] | undefined, prefix: string) {
  return tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

/** The tags on segment `segment` of run `runId`: what the tray and `readRun` find it by. */
export function remixRunTags({
  slug,
  runId,
  segment,
  runtime,
}: {
  slug: string;
  runId: string;
  segment: number;
  runtime: boolean;
}) {
  return [
    REMIX_APP_TAG,
    remixAppTag(slug),
    REMIX_RUN_TAG_PREFIX + runId,
    REMIX_SEGMENT_TAG_PREFIX + segment,
    ...(runtime ? [REMIX_RUNTIME_TAG] : []),
  ];
}
