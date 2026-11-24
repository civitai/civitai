import {
  themeAdvisoriesFrom,
  themeSignals,
  type Advisory,
} from '@civitai/app-assistant/theme-evidence';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

export type { Advisory };

/** The longest a submit waits for the bundle's files to be read: past it, it answers no advisory. */
export const SUBMIT_ADVISORIES_TIMEOUT_MS = 2_000;

export interface SubmitAdvisoryDeps {
  /** The bundle's source files the theme evidence reads (path → UTF-8). */
  files(bundleBuffer: Buffer): Promise<ReadonlyMap<string, string>>;
  timeoutMs?: number;
}

async function liveFiles(bundleBuffer: Buffer): Promise<ReadonlyMap<string, string>> {
  const { bundleSignalFiles } = await import(
    '~/server/services/app-assistant/submission-trace.service'
  );
  return bundleSignalFiles(bundleBuffer);
}

/**
 * WARN, NEVER BLOCK: the advisories a submit answers with, today only `default-theme` (the app
 * reads as Civitai's stock look by `accentCustomizedFrom`, the one rule the trace signal and App
 * Assistant's report_ready use too). Independent of every feature flag.
 *
 * Never throws: a failure answers `[]`. `timeoutMs` bounds the ASYNC part, the unzip and read of
 * the bundle's source files (`files`): past it the submit answers `[]` without waiting, and a read
 * that lands later is not scanned (`timedOut`). The timer cannot interrupt the synchronous
 * `themeSignals` scan once it starts. Here its CPU is bounded by the read cap of
 * `bundleSignalFiles` (8 MiB of source in all) times a scan that is linear in its input.
 * `THEME_SCAN_MAX_CHARS` cannot fire on this path: decoded characters never exceed the bytes read,
 * and its check is a strict `>` at the same 8 MiB. That character budget is defence in depth for
 * callers without a read cap of their own, such as the assistant runner.
 * The same bundle is also unzipped by `extractBundleMetadata` earlier in `submitVersion`, and again
 * by the fire-and-forget trace (`recordSubmissionTrace`) while `app-assistant-tracing` is on.
 */
export async function submitAdvisories(
  bundleBuffer: Buffer,
  { files = liveFiles, timeoutMs = SUBMIT_ADVISORIES_TIMEOUT_MS }: Partial<SubmitAdvisoryDeps> = {}
): Promise<Advisory[]> {
  let timedOut = false;
  const judged = (async () => {
    const read = await files(bundleBuffer);
    // The submit already answered without it: a late read is not worth the scan's CPU.
    if (timedOut) return [];
    return themeAdvisoriesFrom(themeSignals(read).theme);
  })();
  try {
    // `[]` past the bound; a late rejection is swallowed by the helper.
    return await withTimeoutFallback(judged, timeoutMs, [], () => {
      timedOut = true;
    });
  } catch {
    return [];
  }
}
