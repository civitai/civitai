import { faro } from '@grafana/faro-web-sdk';

/**
 * Telemetry for the SILENT browsing-level feed-drop in `useApplyHiddenPreferences`
 * (`case 'models'`).
 *
 * WHAT THIS MEASURES — and its limitation (be honest):
 * The models filter drops a model from the feed when NONE of that model's returned images
 * survive the VIEWER's browsing level (`hidden.noImages++` then `return null`). That drop is
 * invisible in product: `hidden.noImages` is deliberately EXCLUDED from the user-facing
 * `hiddenCount`, so nobody can see how often the feed silently loses models for
 * restricted-browsing (SFW-mode) viewers. This event makes that drop rate MEASURABLE.
 *
 * 🔴 It measures the TOTAL restricted-browsing noImages-drop rate — it does NOT (and CANNOT
 * from the client) isolate the `model.getAll` image-cap's contribution. The shared image array
 * is browsing-level-AGNOSTIC and ordered `postId,index` (not safe-first), so a mixed-level
 * model whose only browsing-safe image sits PAST the cap disappears for SFW viewers. But the
 * client only ever sees the ≤`GET_ALL_IMAGES_PER_MODEL` post-cap images, so a drop where "the
 * cap cut the safe image" is indistinguishable here from a drop where "there genuinely is no
 * browsing-safe image among the returned set". The right use of this signal is to WATCH the
 * aggregate rate: if it is non-trivial or RISES (e.g. after a cap change), the cap or the
 * content mix is dropping models for SFW viewers and a server-side browsing-aware slice is
 * warranted. See `~/server/utils/model-getall-images.ts`.
 *
 * VOLUME — this runs on the feed hot path (`useApplyHiddenPreferences` re-filters on every
 * feed data change, at civitai's request scale). Two gates keep it cheap and non-flooding:
 *   1. AGGREGATE, not per-model: exactly ONE event per filter call, carrying the per-page
 *      `{ droppedNoImages, total }` counts — never one event per dropped model.
 *   2. Only emit when `droppedNoImages > 0` (the common `M === 0` render is silent), then a
 *      low per-emit `sampleRate` (default 0.05) on the drop-present renders — mirroring
 *      `ResourceTimingInstrumentation`'s 0.05 default, chosen to keep the shared
 *      `source="faro-rum"` Loki stream under its ~10 MB/s per-stream ceiling even if SFW-mode
 *      dropping becomes systemic. Because it is a sample, read the emitted counts as a RATE
 *      (proportional), not an exact total; the `sampleRate` rides on each event so a query can
 *      scale.
 *
 * WHERE TO WATCH IT (so the metric isn't itself born-invisible) — Faro `pushEvent` lands in
 * Loki as `kind=event` with `event_name=` + `event_data_*` (see
 * `claudedocs/faro-rum-logql-query-patterns.md`). Drop-events per browsing level:
 *
 *   sum by (event_data_browsingLevel) (
 *     count_over_time({service_name="civitai-dp-prod", source="faro-rum"}
 *       |= `kind=event` |= `feed_noimages_drop` [$__auto])
 *   )
 *
 * Scaled models-dropped total (divide by the sample rate, 0.05):
 *
 *   sum(sum_over_time({service_name="civitai-dp-prod", source="faro-rum"}
 *     |= `feed_noimages_drop` | logfmt | unwrap event_data_droppedNoImages [$__range])) / 0.05
 */

/** Faro event name (→ Loki `event_name="feed_noimages_drop"`). */
export const FEED_NOIMAGES_DROP_EVENT = 'feed_noimages_drop';

/**
 * Default per-emit sample rate for drop-present renders. 0.05 matches
 * `RESOURCE_TIMING_DEFAULTS.sampleRate` — the fraction chosen to keep the shared faro-rum Loki
 * stream under its ~10 MB/s per-stream ceiling at civitai's concurrency.
 */
export const FEED_DROP_DEFAULT_SAMPLE_RATE = 0.05;

export interface FeedNoImagesDropSignal {
  /** Models dropped from THIS page because no returned image survived the viewer's browsing level. */
  droppedNoImages: number;
  /** Total models in the page BEFORE the browsing-level image filter (input length). */
  total: number;
  /** The viewer's active (bitwise) browsing level the filter ran at. */
  browsingLevel: number;
  /** Optional surface tag (feed / collection / home-block …) if the caller knows it. */
  surface?: string;
}

export interface EmitFeedNoImagesDropDeps {
  /**
   * The Faro `pushEvent` fn. Defaults to the global faro instance's api (a no-op when Faro is
   * not initialised — SSR, or the `faro` flag off). Injectable for tests.
   */
  pushEvent?: (name: string, attributes: Record<string, string>) => void;
  /** Injectable RNG — for tests. Defaults to `Math.random`. */
  random?: () => number;
  /** Per-emit sample rate in [0, 1]. Defaults to `FEED_DROP_DEFAULT_SAMPLE_RATE`. */
  sampleRate?: number;
}

/**
 * Emit ONE aggregate telemetry event per feed filter call when the browsing-level filter
 * dropped ≥1 model for `noImages`. Silent when nothing dropped, and sampled otherwise — see the
 * module doc for the volume rationale + the exact Loki watch query. Best-effort: never throws.
 */
export function emitFeedNoImagesDrop(
  signal: FeedNoImagesDropSignal,
  deps: EmitFeedNoImagesDropDeps = {}
): void {
  const { droppedNoImages, total, browsingLevel, surface } = signal;

  // Gate 1 — only emit when something was actually dropped. The overwhelmingly common
  // `droppedNoImages === 0` render is silent, so this alone sheds the vast majority of calls.
  if (!(droppedNoImages > 0)) return;

  // Gate 2 — low sample rate on the remaining (drop-present) renders, so a systemic SFW-mode
  // drop can't flood the shared faro-rum Loki stream at request scale.
  const sampleRate = deps.sampleRate ?? FEED_DROP_DEFAULT_SAMPLE_RATE;
  const random = deps.random ?? Math.random;
  if (sampleRate < 1 && random() >= sampleRate) return;

  try {
    const pushEvent = deps.pushEvent ?? faro?.api?.pushEvent?.bind(faro.api);
    if (!pushEvent) return; // Faro not initialised (SSR / flag off) → no-op.
    pushEvent(FEED_NOIMAGES_DROP_EVENT, {
      droppedNoImages: String(droppedNoImages),
      total: String(total),
      browsingLevel: String(browsingLevel),
      sampleRate: String(sampleRate),
      ...(surface ? { surface } : {}),
    });
  } catch {
    // Telemetry must never break the feed render.
  }
}
