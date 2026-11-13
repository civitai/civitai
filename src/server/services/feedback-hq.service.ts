import { getEdgeUrl } from '~/client-utils/edge-url';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackServerStamp } from '~/server/services/feedback.service';
import type { FeedbackCaptureResult } from '~/server/services/feedback-capture.service';
import { classifyBlockImageUploadScan } from '~/server/services/blocks/block-image-upload.logic';
import { SITE_BUG_REPORT_AREA } from '~/shared/constants/feedback.constants';
import { sniffImageFormat } from '~/shared/utils/image-magic-bytes';
import { redactText } from '~/utils/faro/redact';

const HQ_INTAKE_PATH = '/api/v1/intake/feedback';
const HQ_REQUEST_TIMEOUT_MS = 10_000;

/** HQ's own limits; a request over any of them is refused whole, so we clamp before sending. */
export const HQ_TITLE_MAX_LENGTH = 200;
export const HQ_BODY_MAX_BYTES = 32 * 1024;
export const HQ_LABEL_MAX_COUNT = 8;
export const HQ_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

const TITLE_EXCERPT_MAX_LENGTH = 80;

/** Filing attempts per reporter, on top of `FEEDBACK_RATE_LIMIT` on the submit itself. */
export const HQ_FILING_USER_CAP = { max: 10, windowSeconds: 24 * 60 * 60 };

type FeedbackContextInput = NonNullable<CreateFeedbackInput['context']>;

export type FeedbackHqFilingInput = {
  feedbackId: number;
  userId: number;
  area: string;
  message: string;
  context?: FeedbackContextInput;
  server?: FeedbackServerStamp;
  /** What became of the page capture; null or absent when it was not checked. */
  capture?: FeedbackCaptureResult | null;
};

type HqLogStatus =
  | number
  | 'unconfigured'
  | 'user-cap'
  | 'timeout'
  | 'error'
  | 'bad-response'
  | 'filed';

// Id and outcome only — never the token, the report or HQ's reply.
const log = (feedbackId: number, status: HqLogStatus) =>
  logToAxiom({
    name: 'feedback-hq-intake',
    type: status === 'filed' ? 'info' : 'warning',
    feedbackId,
    status,
  }).catch(() => undefined);

const INVISIBLE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const INLINE_MARKUP_RE = /[[\]()<>*_`#|!~\\]/g;

/** A zero-width space after `@` keeps the text readable but stops HQ notifying anyone. */
const inertMentions = (text: string) => text.replace(/@/g, '@\u200b');

/** A zero-width space after `:` and between dotted words, so no autolinker sees a URL or domain. */
const inertLinks = (text: string) =>
  text.replace(/:/g, ':\u200b').replace(/(\w)\.(?=\w)/g, '$1.\u200b');

/**
 * Stripped before redaction, so removing a character cannot rejoin an email or token after it; the
 * second strip takes the brackets off the redaction markers.
 */
export function neutralizeInline(text: string): string {
  const stripped = text
    .replace(INVISIBLE_RE, ' ')
    .replace(INLINE_MARKUP_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return inertLinks(inertMentions(redactText(stripped).replace(INLINE_MARKUP_RE, '')));
}

const codeSpan = (value: string | number | boolean) =>
  `\`${inertMentions(String(value).replace(/[`\r\n]/g, ' '))}\``;

function fenced(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

function clipBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

export function buildHqTitle(
  input: Pick<FeedbackHqFilingInput, 'feedbackId' | 'message' | 'context'>
) {
  const prefix = `Bug report #${input.feedbackId}`;
  const firstLine = input.message.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const excerpt = [...neutralizeInline(firstLine)]
    .slice(0, TITLE_EXCERPT_MAX_LENGTH)
    .join('')
    .trim();
  if (excerpt) return `${prefix}: ${excerpt}`.slice(0, HQ_TITLE_MAX_LENGTH);
  const route = input.context?.route ? neutralizeInline(input.context.route) : '';
  return (route ? `${prefix} on ${route}` : prefix).slice(0, HQ_TITLE_MAX_LENGTH);
}

export function buildHqLabels(input: Pick<FeedbackHqFilingInput, 'server'>): string[] {
  const labels = [SITE_BUG_REPORT_AREA as string];
  if (input.server?.site) labels.push(`site:${input.server.site}`);
  if (input.server?.tier) labels.push(`tier:${input.server.tier}`);
  return labels
    .map((label) => label.replace(/[^\w:.-]/g, '').slice(0, 50))
    .filter(Boolean)
    .slice(0, HQ_LABEL_MAX_COUNT);
}

function describeDevice(device: FeedbackContextInput['device']) {
  if (!device) return undefined;
  const parts = [
    `viewport ${device.viewport.width}×${device.viewport.height}`,
    `screen ${device.screen.width}×${device.screen.height} @${device.pixelRatio}x`,
    device.touch ? 'touch' : 'no touch',
    device.colorScheme,
    device.language,
    device.timeZone,
  ];
  return parts.filter(Boolean).join(', ');
}

function headerSection(input: FeedbackHqFilingInput, moderatorUrl: string) {
  const { context, server } = input;
  const rows: [string, string | number | undefined][] = [
    ['Area', input.area],
    ['User id', input.userId],
    ['Site', server?.site],
    ['Tier', server?.tier],
    ['Server build', server?.build],
    ['App version (client)', context?.build],
    ['Route', context?.route],
    ['Browser', server?.userAgent],
    ['Device', describeDevice(context?.device)],
    ['Sent at (their clock)', context?.clientAt],
    ['Error ref', context?.errorRef],
    ['Workflow', context?.workflowId],
    ['Job', context?.jobId],
  ];
  const flagsOn = Object.entries(server?.flags ?? {})
    .filter(([, on]) => on)
    .map(([key]) => key);
  if (flagsOn.length) rows.push(['Flags on', flagsOn.join(', ')]);

  const lines = [`- Moderator view: <${moderatorUrl}>`];
  for (const [label, value] of rows)
    if (value !== undefined && value !== '')
      lines.push(`- ${label}: ${codeSpan(redactText(String(value)))}`);
  return lines.join('\n');
}

/** Path only: no origin, query or fragment. The browser recorder does not capture the method. */
function pathOf(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return '(unparseable)';
  }
}

function diagnosticsSection(context: FeedbackContextInput | undefined) {
  if (!context) return '';
  const lines: string[] = [];
  for (const entry of context.consoleErrors ?? [])
    lines.push(`console ${entry.count > 1 ? `×${entry.count} ` : ''}${entry.message}`);
  for (const entry of context.networkErrors ?? [])
    lines.push(`request ${entry.status} ${pathOf(entry.url)}`);
  for (const entry of context.trpcErrors ?? [])
    lines.push(`trpc ${entry.httpStatus ? `${entry.httpStatus} ` : ''}${entry.path} ${entry.code}`);
  if (!lines.length) return '';
  // Redact again: this text leaves the site.
  return `## Diagnostics\n\n${fenced(inertMentions(lines.map(redactText).join('\n')))}`;
}

const TRUNCATED_NOTE = '[truncated: full text in the moderator view]';

/**
 * The task body. Reporter text sits in a fence it cannot close, so none of it renders as HTML, a
 * link, an image or a heading; `@` is made inert everywhere.
 */
export function buildHqBody(
  input: FeedbackHqFilingInput,
  {
    moderatorUrl,
    screenshotAttached,
    screenshotWithheld,
  }: {
    moderatorUrl: string;
    screenshotAttached: boolean;
    /** Why the capture was not attached, when it was considered for attaching. */
    screenshotWithheld?: CaptureWithheldReason | null;
  }
) {
  const header = headerSection(input, moderatorUrl);
  const screenshotNote = input.context?.screenshotId
    ? screenshotAttached
      ? '\n\nThe reporter attached a page capture (below).'
      : screenshotWithheld
      ? `\n\nThe reporter attached a page capture, not attached here: ${CAPTURE_WITHHELD_TEXT[screenshotWithheld]}. See the moderator view.`
      : '\n\nThe reporter attached a page capture: see the moderator view.'
    : '';
  const message = inertMentions(redactText(input.message));
  const diagnostics = diagnosticsSection(input.context);

  const compose = (text: string, withDiagnostics: boolean) =>
    [
      `${header}${screenshotNote}`,
      `## Reporter's words (untrusted)\n\n${fenced(text)}`,
      withDiagnostics ? diagnostics : '',
    ]
      .filter(Boolean)
      .join('\n\n');

  let body = compose(message, true);
  if (byteLength(body) <= HQ_BODY_MAX_BYTES) return body;
  body = compose(message, false);
  if (byteLength(body) <= HQ_BODY_MAX_BYTES) return body;

  const overhead = byteLength(compose(`\n${TRUNCATED_NOTE}`, false)) + 8;
  const clipped = clipBytes(message, HQ_BODY_MAX_BYTES - overhead);
  return compose(`${clipped}\n${TRUNCATED_NOTE}`, false);
}

async function claimHqFilingSlot(userId: number): Promise<boolean> {
  const key = `${REDIS_SYS_KEYS.FEEDBACK.HQ_FILING}:${userId}` as const;
  try {
    const count = await sysRedis.incrBy(key, 1);
    if (count === 1) await sysRedis.expire(key, HQ_FILING_USER_CAP.windowSeconds);
    else if ((await sysRedis.ttl(key)) < 0)
      await sysRedis.expire(key, HQ_FILING_USER_CAP.windowSeconds);
    return count <= HQ_FILING_USER_CAP.max;
  } catch {
    return false;
  }
}

const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/** Reads at most `maxBytes`, or null past it, so an undeclared length cannot buffer an unbounded body. */
async function readCapped(
  res: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function loadScreenshot(screenshotId: string): Promise<Blob | null> {
  try {
    const res = await fetch(getEdgeUrl(screenshotId, { original: true }), {
      signal: AbortSignal.timeout(HQ_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > HQ_SCREENSHOT_MAX_BYTES) return null;
    const bytes = await readCapped(res, HQ_SCREENSHOT_MAX_BYTES);
    if (!bytes?.length) return null;
    // Typed by its bytes: a Content-Type header is the server's claim.
    const format = sniffImageFormat(bytes, {
      formats: ['png', 'jpeg', 'webp'],
      pngSignature: 'full',
    });
    return format ? new Blob([bytes], { type: IMAGE_MIME[format] }) : null;
  } catch {
    return null;
  }
}

export type CaptureWithheldReason =
  | 'not-checked'
  | 'not-owner'
  | 'scanning'
  | 'flagged'
  | 'blocked'
  | 'gone'
  | 'unreadable';

const CAPTURE_WITHHELD_TEXT: Record<CaptureWithheldReason, string> = {
  'not-checked': 'it was not checked',
  'not-owner': "it is not the reporter's upload",
  scanning: 'its scan had not finished',
  flagged: 'its scan flagged it',
  blocked: 'its scan blocked it',
  gone: 'it no longer exists',
  unreadable: 'it could not be read',
};

/** Waits between reads of a capture's scan state: 5 s, backing off, about 2 minutes in all. */
export const CAPTURE_POLL_DELAYS_MS = [5, 5, 10, 10, 15, 15, 20, 20, 20].map((s) => s * 1000);

type CaptureScanRow = Parameters<typeof classifyBlockImageUploadScan>[0];

async function readCaptureScan(imageId: number): Promise<CaptureScanRow | null> {
  return dbWrite.image.findUnique({
    where: { id: imageId },
    select: {
      ingestion: true,
      nsfwLevel: true,
      needsReview: true,
      poi: true,
      minor: true,
      tosViolation: true,
    },
  });
}

/**
 * Whether the capture may go to HQ: only once its scan says SFW with no flags. Polls while it is
 * still scanning. Returns null when it may, else why not.
 */
export async function captureAttachGate(
  capture: FeedbackCaptureResult | null | undefined,
  {
    delays = CAPTURE_POLL_DELAYS_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    read = readCaptureScan,
  }: {
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    read?: (imageId: number) => Promise<CaptureScanRow | null>;
  } = {}
): Promise<CaptureWithheldReason | null> {
  if (!capture) return 'not-checked';
  if ('screenshotCheck' in capture)
    return capture.screenshotCheck === 'not-owner' ? 'not-owner' : 'not-checked';
  for (let attempt = 0; ; attempt++) {
    const row = await read(capture.screenshotImageId).catch(() => undefined);
    if (row === undefined) return 'unreadable';
    if (!row) return 'gone';
    const { status } = classifyBlockImageUploadScan(row);
    if (status === 'ready') return null;
    if (status !== 'pending') return status === 'blocked-flagged' ? 'flagged' : 'blocked';
    if (attempt >= delays.length) return 'scanning';
    await sleep(delays[attempt]);
  }
}

const HQ_TASK_ID_PATTERN = /^[\w-]{1,100}$/;

/** The task HQ returned, or null unless its link is on the same origin we posted to. */
function parseHqReply(reply: unknown, hqOrigin: string): { id: string; url: string } | null {
  if (!reply || typeof reply !== 'object') return null;
  const { id, url } = reply as Record<string, unknown>;
  if (typeof id !== 'string' || !HQ_TASK_ID_PATTERN.test(id) || typeof url !== 'string')
    return null;
  try {
    return new URL(url).origin === hqOrigin ? { id, url } : null;
  } catch {
    return null;
  }
}

export async function recordHqTask(
  feedbackId: number,
  task: { id: string; url: string },
  db: Pick<typeof dbWrite, '$executeRaw'> = dbWrite
) {
  await db.$executeRaw`
    UPDATE "Feedback"
    SET context = jsonb_set(context, '{hq}', ${JSON.stringify(task)}::jsonb, true)
    WHERE id = ${feedbackId}
  `;
}

/**
 * Not awaited by the caller, so it must never throw: the submit has already succeeded. A process
 * that dies mid-call loses this filing; the report itself is saved.
 */
export async function fileFeedbackToHq(input: FeedbackHqFilingInput): Promise<void> {
  try {
    if (input.area !== SITE_BUG_REPORT_AREA) return;
    const baseUrl = env.HQ_INTAKE_URL;
    const token = env.HQ_INTAKE_TOKEN;
    if (!baseUrl || !token) return void (await log(input.feedbackId, 'unconfigured'));
    if (!(await claimHqFilingSlot(input.userId)))
      return void (await log(input.feedbackId, 'user-cap'));

    const screenshotId = input.context?.screenshotId;
    const considered =
      !!screenshotId &&
      (await isFlipt(FLIPT_FEATURE_FLAGS.FEEDBACK_HQ_SCREENSHOT, String(input.userId)));
    let screenshotWithheld = considered ? await captureAttachGate(input.capture) : null;
    const screenshot =
      considered && !screenshotWithheld ? await loadScreenshot(screenshotId) : null;
    if (considered && !screenshotWithheld && !screenshot) screenshotWithheld = 'unreadable';

    const form = new FormData();
    form.set('title', buildHqTitle(input));
    form.set(
      'body',
      buildHqBody(input, {
        moderatorUrl: `${env.MODERATOR_APP_URL.replace(/\/+$/, '')}/feedback/${input.feedbackId}`,
        screenshotAttached: !!screenshot,
        screenshotWithheld,
      })
    );
    for (const label of buildHqLabels(input)) form.append('labels', label);
    if (screenshot) form.set('screenshot', screenshot, `feedback-${input.feedbackId}`);

    const intakeUrl = new URL(HQ_INTAKE_PATH, baseUrl);
    const res = await fetch(intakeUrl, {
      method: 'POST',
      // A redirect would replay the whole report to wherever it points.
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(HQ_REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 201) return void (await log(input.feedbackId, res.status));

    const task = parseHqReply(await res.json().catch(() => null), intakeUrl.origin);
    if (!task) return void (await log(input.feedbackId, 'bad-response'));
    await recordHqTask(input.feedbackId, task);
    await log(input.feedbackId, 'filed');
  } catch (error) {
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
    await log(input.feedbackId, timedOut ? 'timeout' : 'error').catch(() => undefined);
  }
}
