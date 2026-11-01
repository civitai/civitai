import type { ChatToolCall, ChatToolResult } from '@civitai/components-chat/civitai-chat';
import { submitOfferOf } from '@civitai/app-assistant';
import { APPS_RESTRICTED_MESSAGE } from '~/shared/constants/app-submit.constants';
import {
  unjustifiedSensitiveScopes,
  type SensitiveScopeManifestInput,
} from '~/shared/constants/block-scope.constants';
import { getBase64 } from '~/utils/file-utils';
import type { SubmitListingReadiness } from '~/server/services/blocks/publish-request.service';
import { FLOOR_PROBLEM_CODES } from '~/shared/utils/listing-publish-floor';

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
  /** What the submit route said about the app's store listing; absent when it said nothing. */
  listing?: SubmitListingNotice;
}

/**
 * The store-listing half of a submit's answer (the route's `listing`), reduced to what the card
 * says: the route's `approvalBlocked` and `nextStep`, and what else the listing should have.
 */
export type SubmitListingNotice = Pick<SubmitListingReadiness, 'approvalBlocked' | 'nextStep'> & {
  /** Labels of the other problems that keep the listing from going live (e.g. a blocked image). */
  required: string[];
  /** Labels of the recommended-but-optional problems. */
  recommended: string[];
};

/** `value` (the route's `listing`) as a notice, or `undefined` when it is absent or malformed. */
export function listingNoticeOf(value: unknown): SubmitListingNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const problems = Array.isArray(v.problems)
    ? (v.problems as unknown[]).filter(
        (p): p is { code: string; label: string; severity?: unknown } =>
          !!p &&
          typeof (p as { code?: unknown }).code === 'string' &&
          typeof (p as { label?: unknown }).label === 'string'
      )
    : [];
  const approvalBlocked = v.approvalBlocked === true;
  const nextStep = typeof v.nextStep === 'string' && v.nextStep ? v.nextStep : null;
  // Drop the floor problems only when nextStep words them; an update to a live listing has no nextStep.
  return {
    approvalBlocked,
    nextStep,
    required: problems
      .filter((p) => p.severity === 'blocking' && !(nextStep && FLOOR_PROBLEM_CODES.has(p.code)))
      .map((p) => p.label),
    recommended: problems.filter((p) => p.severity !== 'blocking').map((p) => p.label),
  };
}

/** A submit that did not go through: `status` is the route's (0 when it could not be reached). */
export class SubmitError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SubmitError';
  }
}

export const SUBMIT_UNREACHABLE = 'Civitai could not be reached. Try again in a moment.';

/**
 * Whether `civitai app submit` leaves `rel` (a path inside the app) out of its package, for what the
 * export lets through: the root `scratch/` folder (throwaway probes) and any `*.zip` (a package an
 * earlier `app submit` wrote), as the CLI's packager (`pkgzip`) drops them.
 */
export function cliLeavesOut(rel: string): boolean {
  return rel.startsWith('scratch/') || rel.toLowerCase().endsWith('.zip');
}

/**
 * The bundle `civitai app submit` would send, from the app's export: a submission holds the app's
 * files at the root, less what `cliLeavesOut` drops. The export holds them under the app folder
 * (`<app>/…`), which is taken off; an export with `block.manifest.json` at its root is used as it is.
 *
 * 🔴 The sandbox export drops every `.env*` file except `.env.example` upstream (with dependencies,
 * build output, caches, logs and keys), so the bundle never carries one. That includes a root
 * `.env.production`, which the CLI would keep; nothing here adds dotenv files back.
 */
export async function submitBundleFromExport(exported: Blob, app: string): Promise<PreparedSubmit> {
  const { default: JSZip } = await import('jszip');
  const source = await JSZip.loadAsync(await exported.arrayBuffer());
  const out = new JSZip();
  const prefix = source.files[MANIFEST_FILE] ? '' : `${app}/`;
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
  let manifest: Partial<SubmitManifest> & SensitiveScopeManifestInput;
  try {
    manifest = JSON.parse(manifestText) as Partial<SubmitManifest> & SensitiveScopeManifestInput;
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
  const unjustified = unjustifiedSensitiveScopes(manifest);
  if (unjustified.length) throw new SubmitError(unjustifiedScopesMessage(unjustified), 0);
  const bundle = await out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { bundle, manifest: { blockId, name, version } };
}

/** Why the card offers no button for a manifest the submit would refuse for its sensitive scopes. */
export const unjustifiedScopesMessage = (scopes: readonly string[]) =>
  `Your app asks for ${scopes.join(', ')} without saying why it needs ${
    scopes.length === 1 ? 'it' : 'them'
  }. Ask App Assistant to add a reason for ${
    scopes.length === 1 ? 'it' : 'each'
  } to ${MANIFEST_FILE}, then submit again.`;

/** `blob` as base64, without the `data:` prefix. */
async function base64Of(blob: Blob): Promise<string> {
  const url = await getBase64(blob);
  return url.slice(url.indexOf(',') + 1);
}

/** The user's own submission for this app still waits for review (`submitVersion`'s refusal). */
const OWN_PENDING = /^you already have a pending submission for slug /;
export const PENDING_SUBMISSION =
  'Not submitted: this app already has a submission waiting for review. Withdraw it on the Build page (/apps/build), then submit again.';
/** `submitVersion`'s refusal of a version of an app another account owns. */
const OWNED_BY_ANOTHER = /^app \S+ is owned by another user;/;
export const NAME_TAKEN =
  'Not submitted: an app with this name already belongs to another account. Ask App Assistant to give your app a different name, then submit again.';
/** A refusal whose words name a CLI command, which the user has no way to run. */
export const REFUSED_PLAINLY =
  'Not submitted: the submission was refused. Ask App Assistant to check the app, then submit again.';

/** What the user reads when the route refused: its own message, and what to do about it. */
function refusalMessage(status: number, message: string | null): string {
  if (message && OWN_PENDING.test(message)) return PENDING_SUBMISSION;
  if (message && OWNED_BY_ANOTHER.test(message)) return NAME_TAKEN;
  // The service's messages are written for the CLI too; the card never shows a command to run.
  if (message && /\bcivitai app\b/.test(message)) return REFUSED_PLAINLY;
  if (status === 401) return 'You are signed out. Sign in again, then press Submit for review.';
  if (status === 403 && (message === null || message === APPS_RESTRICTED_MESSAGE))
    return `Not submitted: ${APPS_RESTRICTED_MESSAGE}. Your account cannot submit apps for review.`;
  // Refused for how the request came (another site, a token without full access), not who sent it.
  if (status === 403) return `Submitting was refused: ${message}`;
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
    listing: listingNoticeOf(data.listing),
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

/** The heading over the recommended listing items on a sent card. */
export const LISTING_RECOMMENDED_HEADING = 'Recommended for your store listing:';

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
  /** The offer closed while it was being sent: a failed send gives no button back. */
  withdrawn?: true;
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
    if (card.phase === 'sending') card.withdrawn = true;
    if (card.phase !== 'preparing' && card.phase !== 'ready') return;
    card.phase = 'closed';
    show(card, line(OFFER_CLOSED));
  };

  /**
   * What a sent card says about the store listing: the step approval waits on (icon + cover),
   * anything else that keeps it from going live, then what is recommended. The submit itself
   * stands either way: the developer can add art while it waits for review.
   */
  const listingLines = (notice: SubmitListingNotice | undefined): HTMLElement[] => {
    if (!notice) return [];
    const out: HTMLElement[] = [];
    if (notice.nextStep) {
      const next = line(notice.nextStep, 'alert');
      next.setAttribute('data-testid', 'app-assistant-submit-listing-next-step');
      out.push(next);
    }
    for (const label of notice.required) out.push(line(label, 'alert'));
    if (notice.recommended.length) {
      const box = document.createElement('div');
      box.setAttribute('data-testid', 'app-assistant-submit-listing-recommended');
      const list = document.createElement('ul');
      list.style.cssText = 'margin:4px 0 0;padding-left:20px';
      for (const label of notice.recommended) {
        const item = document.createElement('li');
        item.textContent = label;
        list.append(item);
      }
      box.append(line(LISTING_RECOMMENDED_HEADING), list);
      out.push(box);
    }
    return out;
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
      const receipt = await send(prepared);
      card.phase = 'sent';
      show(
        card,
        line(submittedText(prepared.manifest), 'status'),
        ...listingLines(receipt?.listing)
      );
    } catch (error) {
      const message = error instanceof SubmitError ? error.message : SUBMIT_UNREACHABLE;
      // Refused for who the user is or how the request came: pressing again changes nothing.
      if (error instanceof SubmitError && (error.status === 403 || error.status === 401)) {
        card.phase = 'sent';
        show(card, line(message, 'alert'));
        return;
      }
      // The conversation moved on while it was sent: the app may have changed since it was checked.
      if (card.withdrawn) {
        card.phase = 'closed';
        show(card, line(message, 'alert'), line(OFFER_CLOSED));
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
