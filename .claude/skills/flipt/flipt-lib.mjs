// Pure helpers for flipt.mjs, kept free of I/O so they can be tested.

export const STATE_REPO = 'civitai/flipt-state';
export const STATE_PATH = 'civitai-app/default/features.yaml';

// The browser-facing Flipt host answers every path with a GitHub OAuth redirect
// by design. A body that is HTML (or a redirect to a login host) is that front,
// never a flag answer, and must be named instead of parsed.
export function detectHtmlOrOAuth({ status, contentType = '', location = '', body = '' }) {
  const head = String(body).trimStart().slice(0, 200).toLowerCase();
  const isHtml =
    /text\/html/i.test(contentType) ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<');
  const isRedirect = status >= 300 && status < 400;
  if (!isHtml && !isRedirect) return null;
  const oauth = /github\.com\/login|oauth|\/login/i.test(
    location + ' ' + head + ' ' + String(body).slice(0, 2000)
  );
  return (
    'The server answered with ' +
    (isRedirect ? 'a redirect (' + status + ')' : 'an HTML page') +
    (oauth ? ', which looks like the GitHub OAuth login front' : '') +
    ', not Flipt JSON. That front is deliberate; no token gets past it. This is NOT "flag not found".'
  );
}

export const LIVE_REFUSAL = [
  'Live flag state is not available from this skill.',
  'The public Flipt host answers every path with a GitHub OAuth login on purpose, so a bearer token cannot reach it.',
  'The supported path is an in-cluster read done by the DevOps seat (gated): ask that seat, or an infra owner, for the live value.',
  'Meanwhile, drop --live: get/list return the flag DEFINITION from flipt-state git, which is what the live server loads (it can lag by a sync interval, and an env override can still change app behavior).',
].join('\n');

export function flagsFromYaml(yamlText, parseYaml) {
  const doc = parseYaml(yamlText);
  if (!doc || !Array.isArray(doc.flags)) throw new Error('features.yaml has no flags: list');
  return doc.flags;
}

export function findFlag(flags, key) {
  return flags.find((f) => f.key === key) ?? null;
}

// A rollout matching two segments under AND vs OR reaches completely different
// audiences, so the operator is only omitted when there is nothing to combine.
export function formatSegments(segments, segmentOperator) {
  const keys = segments ?? [];
  if (keys.length === 0) return 'unknown';
  if (keys.length === 1) return keys[0];
  const op = segmentOperator === 'AND_SEGMENT_OPERATOR' ? 'AND' : 'OR';
  return keys.join(' ' + op + ' ');
}
