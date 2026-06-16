/**
 * Bounded retry-with-backoff for riding out TRANSIENT preview-infra flakiness
 * (the shared search backend — feeds-proxy/meili — intermittently 5xx's under
 * concurrent preview-build load; cold-SSR page loads stall) WITHOUT masking a
 * real failure: the wrapped step must still eventually succeed, and if every
 * attempt fails the last error surfaces and the spec fails honestly.
 *
 * Why not rely on Playwright's `retries`: those re-run the WHOLE test within a
 * few seconds of each other — too fast to outlast a load spike (the failing
 * runs exhausted all 3 attempts in <10s). This retries the single flaky step
 * with real spacing so a brief spike is ridden out.
 *
 * NOT a test file (excluded from the preview config testMatch).
 */
export async function retryFlaky<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; backoffMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 6000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        // eslint-disable-next-line no-console
        console.warn(
          `[retryFlaky] "${label}" failed attempt ${attempt}/${attempts}; retrying in ${
            backoffMs * attempt
          }ms`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }
  }
  throw lastErr;
}
