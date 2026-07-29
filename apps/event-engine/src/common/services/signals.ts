// Bound every send so a truly hung signals endpoint can never stall the
// (best-effort) caller — this also caps the awaited hot-path `sendDelta`.
// NOTE: set generously (10s) — the signals endpoint's normal response time
// routinely exceeds 2s, and those sends succeed. A tighter timeout aborts
// normal-but-slow sends and turns them into failures (a 2s value regressed
// the failure rate 0.13% -> ~1%); 10s only catches a genuine hang.
const REQUEST_TIMEOUT_MS = 10000;

// Connection-level failure codes we retry once (on a fresh connection). The
// dominant one here is the undici keep-alive race: a pooled idle socket the
// server has already closed gets reused, surfacing as `read ECONNRESET`.
const TRANSIENT_CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET']);

function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  return typeof code === 'string' && TRANSIENT_CONNECTION_CODES.has(code);
}

export class SignalsService {
  private signalsApiUrl: string;
  private enabled: boolean;

  constructor(apiUrl?: string, enabled: boolean = true) {
    this.signalsApiUrl = apiUrl || '';
    this.enabled = enabled && !!this.signalsApiUrl;

    if (!this.enabled) {
      console.warn('[SignalsService] Signals API disabled or URL not configured');
    }
  }

  /**
   * Send a signal to a specific topic.
   *
   * Best-effort telemetry: bounded by a short timeout and retried once on a
   * transient connection-level error (see the undici keep-alive race above).
   * On final failure it logs and rethrows so the caller
   * (`MetricSignals.sendDelta`) records the failure metric and swallows it —
   * the fire-and-forget contract is unchanged.
   *
   * @param topic The topic to send the signal to
   * @param signalName The name of the signal event
   * @param payload The payload to send
   */
  async sendSignal<T = any>(
    topic: string,
    signalName: string,
    payload: T
  ): Promise<void> {
    if (!this.enabled) return;

    const url = `${this.signalsApiUrl}/topics/${topic}/signals/${signalName}`;
    const body = JSON.stringify(payload);

    // One retry on a transient connection reset: a fresh connection avoids the
    // stale pooled socket that caused the reset.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (!response.ok) {
          throw new Error(`Signal API returned ${response.status}: ${response.statusText}`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isTransientConnectionError(error)) {
          continue; // retry once on a fresh connection
        }
        break;
      }
    }

    // Best-effort telemetry — warn (not error) to reduce log noise, then
    // rethrow so the caller's failure metric + swallow still apply.
    console.warn(`[SignalsService] Failed to send signal to topic ${topic}:`, lastError);
    throw lastError;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}