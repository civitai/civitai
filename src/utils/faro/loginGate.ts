import { faro } from '@grafana/faro-web-sdk';
import type { SessionDiagnostics } from '~/providers/SessionProvider';
import { buildRumPageAttributes } from '~/utils/faro/pageAttributes';

/**
 * Diagnostic: `Gated` showed its login card (`LoginRequiredCard`) to a viewer whose hard load was
 * made WITH a session cookie — a signed-in viewer told to sign in. A reload clears it and the cause
 * is not known, so this records, once per document, how the session got to "signed out":
 *
 *   render_mode          `shell` | `ssr` (as `pageAttributes.ts` names it)
 *   session_boot         what SessionProvider mounted with: `ssr-session` | `ssr-null` |
 *                        `ssr-unknown` | `shell`
 *   session_cookie       the server saw a session cookie on the hard load: `true` | `false` |
 *                        `unknown` (a shell render reads no viewer cookie)
 *   session_history      distinct statuses since mount, e.g. `loading>unauthenticated`
 *   session_source       what produced the current value: `ssr` | `shell-seed` |
 *                        `fetch:<trigger>` | `fetch:<trigger>:undetermined`
 *   shell_seed_session   the shell page data's session: `present` | `null` | `none` (not adopted)
 *   shell_page_data      the shell page-data HTTP status, `pending`, or `none` (not a shell)
 *   last_fetch           the last `/api/auth/session` answer: `ok-session` | `ok-null` |
 *                        `undetermined` | `none`
 *   last_fetch_status    its HTTP status (`0` = network error) or `none`
 *   last_fetch_trigger   `mount` | `focus` | `interval` | `update` | `refresh-signal` | `none`
 *   fetch_count          session fetches completed since mount
 *   content_nsfw_level   the gated content's level (a number)
 *   ms_since_nav_start   `performance.now()` at the gate, rounded
 *   sampleRate           `1` (every occurrence is sent; see `tour.ts`)
 *
 * PII: literal enums and small numbers only — no user id, name, email, token, cookie value or URL.
 * They match none of the `deepRedact` patterns (pinned in the unit test). Faro adds the app
 * version and the page URL (query params scrubbed by `beforeSend`) itself.
 *
 * WHERE TO WATCH IT — Faro `pushEvent` lands in Loki as `kind=event` with `event_name=` and
 * `event_data_*` fields, e.g. `|= "kind=event" |= "event_name=login_gate_with_auth_cookie"`,
 * then `sum by (event_data_session_boot, event_data_session_source)`.
 */

export const LOGIN_GATE_WITH_AUTH_COOKIE_EVENT = 'login_gate_with_auth_cookie';

export type LoginGateSignal = {
  diagnostics: SessionDiagnostics;
  contentNsfwLevel: number;
  /** `shellPageDataStatus()`. */
  shellPageDataStatus: number | undefined;
  msSinceNavStart: number;
};

export function buildLoginGateAttributes({
  diagnostics: d,
  contentNsfwLevel,
  shellPageDataStatus,
  msSinceNavStart,
}: LoginGateSignal): Record<string, string> {
  const shell = d.boot === 'shell';
  return {
    render_mode: buildRumPageAttributes({ shell, signedIn: true }).render_mode,
    session_boot: d.boot,
    session_cookie: d.sessionCookie === undefined ? 'unknown' : String(d.sessionCookie),
    session_history: d.history.join('>'),
    session_source: d.source,
    shell_seed_session: d.seedSession ?? 'none',
    shell_page_data: !shell
      ? 'none'
      : shellPageDataStatus === undefined
      ? 'pending'
      : String(shellPageDataStatus),
    last_fetch: d.lastFetch?.outcome ?? 'none',
    last_fetch_status: d.lastFetch ? String(d.lastFetch.httpStatus) : 'none',
    last_fetch_trigger: d.lastFetch?.trigger ?? 'none',
    fetch_count: String(d.fetchCount),
    content_nsfw_level: String(contentNsfwLevel),
    ms_since_nav_start: String(Math.round(msSinceNavStart)),
    sampleRate: '1',
  };
}

// Once per document: the module lives exactly as long as the page load.
let reported = false;

export type ReportLoginGateDeps = {
  /** Injectable for tests; defaults to the global Faro instance (absent → no-op). */
  pushEvent?: (name: string, attributes: Record<string, string>) => void;
};

/**
 * Sends the event if the viewer's hard load had a session cookie and none was sent yet in this
 * document. `no-faro` = Faro is not initialised (yet); the caller may retry. Never throws.
 */
export function reportLoginGateWithAuthCookie(
  signal: LoginGateSignal,
  deps: ReportLoginGateDeps = {}
): 'sent' | 'skipped' | 'no-faro' {
  try {
    if (reported || !signal.diagnostics.authCookieAtLoad) return 'skipped';
    // Before `initializeFaro`, `faro` is `{ api: <no-op> }`: an event sent to it is dropped
    // silently, so `config` (set only by initialisation) is the readiness check.
    const pushEvent =
      deps.pushEvent ?? (faro?.config ? faro.api?.pushEvent?.bind(faro.api) : undefined);
    if (!pushEvent) return 'no-faro';
    // MUTANT M2: reported = true;
    pushEvent(LOGIN_GATE_WITH_AUTH_COOKIE_EVENT, buildLoginGateAttributes(signal));
    return 'sent';
  } catch {
    // The gate must survive its own telemetry.
    return 'skipped';
  }
}

/** Tests only. */
export function resetLoginGateReportForTests() {
  reported = false;
}
