import type { ChatToolCall, ChatToolResult } from '@civitai/components-chat/civitai-chat';
import { submitOfferOf } from '@civitai/app-assistant';

/**
 * Submit for review from App Assistant: the user's press on the card a `submit_for_review` call shows
 * sends the app to the moderator review queue, through the same route and `submitVersion` service as
 * any other submission, signed in as the user. Nothing here can submit without that press.
 */

/** The session-authed submit route: the same gates as the CLI's token route, the same service. */
export const SUBMIT_VERSION_ROUTE = '/api/blocks/submit-version';
/** At the bundle's root, as `submitVersion` reads it. */
export const MANIFEST_FILE = 'block.manifest.json';

export interface SubmitManifest {
  blockId: string;
  name: string;
  version: string;
}

/** The bundle the press sends, and what the card says it is. */
export interface PreparedSubmit {
  bundle: Blob;
  manifest: SubmitManifest;
}

export interface SubmitReceipt {
  publishRequestId: string;
  slug: string;
  version: string;
}

/** A submit that did not go through: `status` is the route's (0 when it could not be reached). */
export class SubmitError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SubmitError';
  }
}

export const SUBMIT_UNREACHABLE = 'Civitai could not be reached. Try again in a moment.';

/** Dotenv files the CLI's packager keeps, and only at the project root (`pkgzip.keptEnvFiles`). */
const KEPT_ROOT_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.production']);

/**
 * Whether `civitai app submit` leaves `rel` (a path inside the app) out of its package, for the
 * rules an export can still let through (`pkgzip`): the root `scratch/` folder, any `*.zip`, a
 * dotenv-shaped folder (`.env` or `.env.*`), and every file named `.env*` or `*.env`, except
 * `.env.example`, `.env.sample` and `.env.production` at the root. Case is ignored, as there.
 */
export function cliLeavesOut(rel: string): boolean {
  const parts = rel.split('/');
  const name = parts[parts.length - 1].toLowerCase();
  if (parts.length > 1 && parts[0] === 'scratch') return true;
  if (parts.slice(0, -1).some((dir) => /^\.env(\.|$)/i.test(dir))) return true;
  if (name.endsWith('.zip')) return true;
  if (parts.length === 1 && KEPT_ROOT_ENV_FILES.has(parts[0])) return false;
  return name.startsWith('.env') || name.endsWith('.env');
}

/**
 * The bundle `civitai app submit` would send, from the app's export: the export holds the app folder
 * (`<app>/…`), and a submission holds its contents at the root, less what the CLI leaves out
 * (`cliLeavesOut`). The export itself already drops dependencies, build output, caches, logs and
 * keys; it also drops every `.env*` file but `.env.example`, so a root `.env.production` the CLI
 * would keep reaches the bundle only once the export sends it.
 */
export async function submitBundleFromExport(exported: Blob, app: string): Promise<PreparedSubmit> {
  const { default: JSZip } = await import('jszip');
  const source = await JSZip.loadAsync(await exported.arrayBuffer());
  const out = new JSZip();
  const prefix = `${app}/`;
  let manifestText: string | null = null;
  for (const [path, entry] of Object.entries(source.files)) {
    if (entry.dir || !path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (!rel || cliLeavesOut(rel)) continue;
    const bytes = await entry.async('uint8array');
    if (rel === MANIFEST_FILE) manifestText = new TextDecoder().decode(bytes);
    out.file(rel, bytes);
  }
  if (manifestText === null)
    throw new SubmitError(
      `Your app has no ${MANIFEST_FILE}, so it cannot be submitted. Ask App Assistant to add it.`,
      0
    );
  let manifest: Partial<SubmitManifest>;
  try {
    manifest = JSON.parse(manifestText) as Partial<SubmitManifest>;
  } catch {
    throw new SubmitError(
      `Your app's ${MANIFEST_FILE} is not valid JSON. Ask App Assistant to fix it.`,
      0
    );
  }
  const { blockId, name, version } = manifest ?? {};
  if (typeof blockId !== 'string' || typeof name !== 'string' || typeof version !== 'string')
    throw new SubmitError(
      `Your app's ${MANIFEST_FILE} needs a blockId, a name and a version. Ask App Assistant to fix it.`,
      0
    );
  // The folder exported is the app's: a manifest naming another blockId would submit another slug.
  if (blockId !== app)
    throw new SubmitError(
      `Your app's ${MANIFEST_FILE} names its blockId "${blockId}", not "${app}". Ask App Assistant to fix it.`,
      0
    );
  const bundle = await out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { bundle, manifest: { blockId, name, version } };
}

/** `blob` as base64, without the `data:` prefix. */
async function base64Of(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

/** What the user reads when the route refused: its own message, and what to do about it. */
function refusalMessage(status: number, message: string | null): string {
  if (status === 401) return 'You are signed out. Sign in again, then press Submit for review.';
  if (status === 403)
    return `Not submitted: ${
      message ?? 'your account cannot submit apps'
    }. Your account cannot submit apps for review.`;
  if (status === 413) return 'Not submitted: this app is too large to submit.';
  if (status === 429)
    return 'Not submitted: too many submissions just now. Wait a minute, then press Submit for review again.';
  if (status === 400 && message)
    return `Not submitted: ${message}. Ask App Assistant to fix this, then submit again.`;
  return SUBMIT_UNREACHABLE;
}

/** Sends `prepared` to the review queue as the signed-in user. */
export async function sendForReview(
  prepared: PreparedSubmit,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<SubmitReceipt> {
  let res: Response;
  try {
    res = await fetchImpl(SUBMIT_VERSION_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundleBase64: await base64Of(prepared.bundle) }),
    });
  } catch {
    throw new SubmitError(SUBMIT_UNREACHABLE, 0);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || typeof data?.publishRequestId !== 'string') {
    const message =
      typeof data?.message === 'string'
        ? data.message
        : typeof data?.error === 'string'
        ? data.error
        : null;
    throw new SubmitError(refusalMessage(res.ok ? 0 : res.status, message), res.status);
  }
  return {
    publishRequestId: data.publishRequestId,
    slug: typeof data.slug === 'string' ? data.slug : prepared.manifest.blockId,
    version: typeof data.version === 'string' ? data.version : prepared.manifest.version,
  };
}

export const SUBMIT_BUTTON_TEXT = 'Submit for review';
export const OFFER_CLOSED =
  'This offer closed because the conversation moved on. Ask App Assistant to submit the app again.';
export const submittedText = ({ name, version }: SubmitManifest) =>
  `Submitted ${name} ${version} for review. A moderator reviews it before it goes live in the App Store.`;

export interface SubmitCardsDeps {
  /** The app (by sandbox name) as the bundle a press would send. */
  prepare(sandbox: string): Promise<PreparedSubmit>;
  send(prepared: PreparedSubmit): Promise<SubmitReceipt>;
}

export interface SubmitCards {
  /** The card for a `submit_for_review` call; the default card for one that offered nothing. */
  render(call: ChatToolCall): HTMLElement | undefined;
  /** Every finished call, as the page hears of it: an offer opens; any later call closes it. */
  onToolResult(result: ChatToolResult, sandbox: string | null): void;
  /** The conversation moved on (a new reply, a message): the open offer closes. */
  withdraw(): void;
  /** Another app opened (by sandbox name): an offer made for a different one closes. */
  appChanged(sandbox: string | null): void;
}

/** `waiting`: shown, but not (yet) the open offer: the page may hear of the call after it shows it. */
type Phase = 'waiting' | 'preparing' | 'ready' | 'sending' | 'sent' | 'closed';

interface Card {
  el: HTMLElement;
  phase: Phase;
}

const CARD_STYLE =
  'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
const BUTTON_STYLE =
  'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:0;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:var(--civitai-color-primary, #228be6)';

/**
 * The Submit for review cards. Only the offer the latest `submit_for_review` made gets a button, and
 * only until anything else happens in the conversation: the checks it passed were of the app as it
 * was then. An offer from an earlier visit has an id this page never issued, so it shows no button.
 */
export function createSubmitCards({ prepare, send }: SubmitCardsDeps): SubmitCards {
  const cards = new Map<string, Card>();
  let open: { id: string; sandbox: string } | null = null;

  const line = (text: string, role: 'status' | 'alert' | null = null) => {
    const el = document.createElement('div');
    el.textContent = text;
    if (role) el.setAttribute('role', role);
    return el;
  };

  const show = (card: Card, ...children: HTMLElement[]) => {
    const title = document.createElement('div');
    title.textContent = 'Submit for review';
    title.style.fontWeight = '600';
    card.el.replaceChildren(title, ...children);
  };

  const close = (card: Card) => {
    if (card.phase !== 'preparing' && card.phase !== 'ready') return;
    card.phase = 'closed';
    show(card, line(OFFER_CLOSED));
  };

  const offerButton = (card: Card, prepared: PreparedSubmit, error?: string) => {
    const { name, version, blockId } = prepared.manifest;
    const what = line(`${name} ${version} (${blockId})`);
    what.setAttribute('data-testid', 'app-assistant-submit-what');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = SUBMIT_BUTTON_TEXT;
    button.style.cssText = BUTTON_STYLE;
    button.addEventListener('click', () => void press(card, prepared, button));
    const note = line('A moderator reviews it before it goes live.');
    show(card, what, note, ...(error ? [line(error, 'alert')] : []), button);
  };

  const press = async (card: Card, prepared: PreparedSubmit, button: HTMLButtonElement) => {
    if (card.phase !== 'ready') return;
    card.phase = 'sending';
    button.disabled = true;
    button.textContent = 'Submitting…';
    try {
      await send(prepared);
      card.phase = 'sent';
      show(card, line(submittedText(prepared.manifest), 'status'));
    } catch (error) {
      const message = error instanceof SubmitError ? error.message : SUBMIT_UNREACHABLE;
      // Refused for who the user is: pressing again changes nothing.
      if (error instanceof SubmitError && (error.status === 403 || error.status === 401)) {
        card.phase = 'sent';
        show(card, line(message, 'alert'));
        return;
      }
      card.phase = 'ready';
      offerButton(card, prepared, message);
    }
  };

  const start = (card: Card, sandbox: string) => {
    card.phase = 'preparing';
    show(card, line('Packaging your app…', 'status'));
    prepare(sandbox).then(
      (prepared) => {
        if (card.phase !== 'preparing') return;
        card.phase = 'ready';
        offerButton(card, prepared);
      },
      (error) => {
        if (card.phase !== 'preparing') return;
        card.phase = 'closed';
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Your app could not be packaged.';
        show(card, line(`Not submitted: ${message}`, 'alert'));
      }
    );
  };

  /** The card for offer `id`: made once, then the same element on every render. */
  const cardFor = (id: string) => {
    let card = cards.get(id);
    if (card) return card;
    const el = document.createElement('div');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Submit for review');
    el.style.cssText = CARD_STYLE;
    card = { el, phase: 'waiting' };
    show(card);
    cards.set(id, card);
    if (open?.id === id) start(card, open.sandbox);
    return card;
  };

  const withdraw = () => {
    open = null;
    for (const card of cards.values()) close(card);
  };

  return {
    render(call) {
      const id = submitOfferOf({
        name: call.name,
        input: call.input,
        output: call.output,
        isError: call.state === 'error',
      });
      if (call.state !== 'done' || !id) return undefined;
      return cardFor(id).el;
    },
    onToolResult(result, sandbox) {
      const id = submitOfferOf(result);
      // A later call (in this reply or a subagent's) may have changed the app since it was checked.
      withdraw();
      if (!id || !sandbox) return;
      open = { id, sandbox };
      const card = cards.get(id);
      if (card?.phase === 'waiting') start(card, sandbox);
    },
    withdraw,
    appChanged(sandbox) {
      if (open && open.sandbox !== sandbox) withdraw();
    },
  };
}
