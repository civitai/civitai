import {
  themeAdvisoriesFrom,
  themeSignals,
  type Advisory,
} from '@civitai/app-assistant/theme-evidence';

export type { Advisory };

/** The longest a submit waits for its advisories: past it, the submit answers without them. */
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
 * Never throws and never waits past `timeoutMs`: a failure or a slow read answers `[]`, so an
 * advisory can neither fail nor hold up a submission.
 */
export async function submitAdvisories(
  bundleBuffer: Buffer,
  { files = liveFiles, timeoutMs = SUBMIT_ADVISORIES_TIMEOUT_MS }: Partial<SubmitAdvisoryDeps> = {}
): Promise<Advisory[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Advisory[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });
  const judged = (async () => themeAdvisoriesFrom(themeSignals(await files(bundleBuffer)).theme))();
  try {
    return await Promise.race([judged, late]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    // A judgement that lost the race and fails later must not surface as an unhandled rejection.
    judged.catch(() => undefined);
  }
}
