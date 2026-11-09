import { getEdgeUrl } from '~/client-utils/edge-url';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackServerStamp } from '~/server/services/feedback.service';
import { SITE_BUG_REPORT_AREA } from '~/shared/constants/feedback.constants';
import { deepRedact, redactText } from '~/utils/faro/redact';

const HQ_INTAKE_PATH = '/api/v1/intake/feedback';
const HQ_REQUEST_TIMEOUT_MS = 10_000;

/** HQ's own limits; a request over any of them is refused whole, so we clamp before sending. */
export const HQ_TITLE_MAX_LENGTH = 200;
export const HQ_BODY_MAX_BYTES = 32 * 1024;
export const HQ_LABEL_MAX_COUNT = 8;
export const HQ_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

const TITLE_EXCERPT_MAX_LENGTH = 80;

/**
 * Per reporter, on top of `FEEDBACK_RATE_LIMIT` on the submit itself. Over it the report is still
 * saved; it is just not filed.
 */
export const HQ_FILING_USER_CAP = { max: 10, windowSeconds: 24 * 60 * 60 };

type FeedbackContextInput = NonNullable<CreateFeedbackInput['context']>;

export type FeedbackHqFilingInput = {
  feedbackId: number;
  userId: number;
  area: string;
  message: string;
  context?: FeedbackContextInput;
  server?: FeedbackServerStamp;
};

type HqLogStatus =
  | number
  | 'unconfigured'
  | 'user-cap'
  | 'timeout'
  | 'error'
  | 'bad-response'
  | 'filed';

// Only the id and an outcome: a log line must never carry the token, the report or HQ's reply.
const log = (feedbackId: number, status: HqLogStatus) =>
  logToAxiom({
    name: 'feedback-hq-intake',
    type: status === 'filed' ? 'info' : 'warning',
    feedbackId,
    status,
  }).catch(() => undefined);

// Control, format (bidi overrides, zero-width) and line/paragraph separators.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
// Characters that start markdown or HTML syntax in a single-line context.
const INLINE_MARKUP_RE = /[[\]()<>*_`#|!~\\]/g;

/** `@name` would notify someone in HQ. A zero-width space after the `@` keeps it readable and inert. */
const inertMentions = (text: string) => text.replace(/@/g, '@\u200b');

/** One line of user text safe to show outside a code block: no markup, no mentions, no secrets. */
export function neutralizeInline(text: string): string {
  return inertMentions(
    redactText(text)
      .replace(INVISIBLE_RE, ' ')
      .replace(INLINE_MARKUP_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** A server-known value as an inline code span. Backticks and newlines would end the span. */
const codeSpan = (value: string | number | boolean) =>
  `\`${inertMentions(String(value).replace(/[`\r\n]/g, ' '))}\``;

/** A fenced block that no content can close: the fence is longer than any backtick run inside. */
function fenced(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/** Cuts to at most `maxBytes` of UTF-8 without splitting a character. */
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
    ['Session', context?.sessionId],
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

function diagnosticsSection(context: FeedbackContextInput | undefined) {
  if (!context) return '';
  const lines: string[] = [];
  for (const entry of context.consoleErrors ?? [])
    lines.push(`console ${entry.count > 1 ? `×${entry.count} ` : ''}${entry.message}`);
  for (const entry of context.networkErrors ?? [])
    lines.push(`request ${entry.status} ${entry.url} (${entry.initiatorType})`);
  for (const entry of context.trpcErrors ?? [])
    lines.push(`trpc ${entry.httpStatus ? `${entry.httpStatus} ` : ''}${entry.path} ${entry.code}`);
  if (!lines.length) return '';
  // Already redacted by the browser recorders; scrubbed again because this leaves the site.
  return `## Diagnostics\n\n${fenced(inertMentions(deepRedact(lines).join('\n')))}`;
}

const TRUNCATED_NOTE = '[truncated: full text in the moderator view]';

/**
 * The task body. Everything the reporter typed sits inside a fence it cannot close, so none of it
 * renders as HTML, a link, an image or a heading; `@` is made inert everywhere. Over HQ's limit the
 * diagnostics go first, then the message is clipped.
 */
export function buildHqBody(
  input: FeedbackHqFilingInput,
  { moderatorUrl, screenshotAttached }: { moderatorUrl: string; screenshotAttached: boolean }
) {
  const header = headerSection(input, moderatorUrl);
  const screenshotNote = input.context?.screenshotId
    ? screenshotAttached
      ? '\n\nThe reporter attached a page capture (below).'
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

/** Fixed window per reporter. Fails closed: if Redis cannot count, nothing is filed. */
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

/** The image type from its first bytes. A `Content-Type` header is the server's claim, not this. */
export function sniffImageType(
  bytes: Uint8Array
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** The opt-in page capture as an attachable file, or null when it is missing, too big or not an image. */
async function loadScreenshot(screenshotId: string): Promise<Blob | null> {
  try {
    const res = await fetch(getEdgeUrl(screenshotId, { original: true }), {
      signal: AbortSignal.timeout(HQ_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > HQ_SCREENSHOT_MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > HQ_SCREENSHOT_MAX_BYTES) return null;
    const type = sniffImageType(bytes);
    return type ? new Blob([bytes], { type }) : null;
  } catch {
    return null;
  }
}

const HQ_TASK_ID_PATTERN = /^[\w-]{1,100}$/;

function parseHqReply(reply: unknown): { id: string; url: string } | null {
  if (!reply || typeof reply !== 'object') return null;
  const { id, url } = reply as Record<string, unknown>;
  if (typeof id !== 'string' || !HQ_TASK_ID_PATTERN.test(id) || typeof url !== 'string')
    return null;
  try {
    return new URL(url).protocol === 'https:' ? { id, url } : null;
  } catch {
    return null;
  }
}

/**
 * Writes ONLY `context.hq` on that one row. `jsonb_set` keeps every other key, the server stamp
 * included, exactly as it was saved.
 */
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
 * Files one HQ task for a saved site bug report. Called without `await` after the row is written:
 * it never throws, and every outcome other than a filing is one log line. A process that dies
 * mid-call loses this filing; the report itself is already saved.
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
    const screenshot =
      screenshotId &&
      (await isFlipt(FLIPT_FEATURE_FLAGS.FEEDBACK_HQ_SCREENSHOT, String(input.userId)))
        ? await loadScreenshot(screenshotId)
        : null;

    const form = new FormData();
    form.set('title', buildHqTitle(input));
    form.set(
      'body',
      buildHqBody(input, {
        moderatorUrl: `${env.MODERATOR_APP_URL.replace(/\/+$/, '')}/feedback/${input.feedbackId}`,
        screenshotAttached: !!screenshot,
      })
    );
    for (const label of buildHqLabels(input)) form.append('labels', label);
    if (screenshot) form.set('screenshot', screenshot, `feedback-${input.feedbackId}`);

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${HQ_INTAKE_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(HQ_REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 201) return void (await log(input.feedbackId, res.status));

    const task = parseHqReply(await res.json().catch(() => null));
    if (!task) return void (await log(input.feedbackId, 'bad-response'));
    await recordHqTask(input.feedbackId, task);
    await log(input.feedbackId, 'filed');
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    await log(input.feedbackId, timedOut ? 'timeout' : 'error').catch(() => undefined);
  }
}
