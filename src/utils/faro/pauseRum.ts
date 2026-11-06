import { faro } from '@grafana/faro-web-sdk';

/**
 * Stop this document's RUM beacons for good, before it navigates away from itself.
 *
 * Used when a shell page leaves for a full render (`useShellBootstrap`'s fallback): the shell
 * document is being thrown away, and without this its page-hide flush would still send its
 * LCP/CLS/INP tagged `render_mode=shell` (`~/utils/faro/pageAttributes`), counting an aborted
 * shell as a shell load. Beacons the SDK already sent (typically TTFB/FCP) cannot be recalled.
 *
 * Faro 2.8.2 `pause()` (faro-core transports): a paused SDK returns early from `execute`, so new
 * beacons are DROPPED, not queued; the batch buffer is not flushed while paused, including on
 * page hide. A no-op when Faro was never initialised (`faro` is then an empty object). Never
 * throws: RUM must not stand between the page and its fallback navigation.
 */
export function pauseRum() {
  try {
    faro?.pause?.();
  } catch {
    // ignore
  }
}
