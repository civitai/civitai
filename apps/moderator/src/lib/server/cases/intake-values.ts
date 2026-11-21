import { z } from 'zod';
import type { ProcessDefinition } from '@civitai/moderation/process-definition';

type Value = string | string[] | boolean;
export type IntakeValues = Record<string, Value>;

const email = z.email();
const httpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Checks a public submission against its definition's fields. Every problem is reported by field id,
 * so the form can show them all at once. A field the definition doesn't have is refused rather than
 * stored: the record holds only what the form asked for.
 */
export function checkIntakeValues(def: ProcessDefinition, values: IntakeValues) {
  const errors: Record<string, string> = {};
  const fields = new Map(def.fields.map((f) => [f.id, f]));
  for (const id of Object.keys(values))
    if (!fields.has(id)) errors[id] = 'Not a field of this form.';

  for (const f of def.fields) {
    const v = values[f.id];
    const empty =
      v === undefined ||
      v === false ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.every((s) => s.trim() === ''));
    if (empty) {
      if (f.required)
        errors[f.id] = f.kind === 'checkbox' ? 'Required: tick to confirm.' : 'Required.';
      continue;
    }
    switch (f.kind) {
      case 'checkbox':
        if (v !== true) errors[f.id] = 'Expected a tick.';
        break;
      case 'urlList': {
        const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s+/) : [];
        const urls = list.map((s) => s.trim()).filter(Boolean);
        if (!urls.length || urls.some((u) => !httpUrl(u)))
          errors[f.id] = 'Each line must be a web address starting with https://.';
        break;
      }
      case 'url':
        if (typeof v !== 'string' || !httpUrl(v.trim())) errors[f.id] = 'Expected a web address.';
        break;
      case 'email':
        if (typeof v !== 'string' || !email.safeParse(v.trim()).success)
          errors[f.id] = 'Expected an email address.';
        break;
      case 'select':
        if (typeof v !== 'string' || !(f.options ?? []).some((o) => o.value === v))
          errors[f.id] = 'Choose one of the options.';
        break;
      default:
        if (typeof v !== 'string') errors[f.id] = 'Expected text.';
    }
  }
  return errors;
}

/** The URLs a submission names, from every urlList and url field, de-duplicated in order. */
export function submittedUrls(def: ProcessDefinition, values: IntakeValues) {
  const out: string[] = [];
  for (const f of def.fields) {
    if (f.kind !== 'urlList' && f.kind !== 'url') continue;
    const v = values[f.id];
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s+/) : [];
    for (const u of list.map((s) => s.trim()).filter(Boolean)) if (!out.includes(u)) out.push(u);
  }
  return out;
}

const CIVITAI_HOSTS = new Set(['civitai.com', 'www.civitai.com', 'civitai.green', 'civitai.red']);
const ENTITY_PATH: [RegExp, string][] = [
  [/^\/models\/(\d+)/, 'Model'],
  [/^\/images\/(\d+)/, 'Image'],
  [/^\/posts\/(\d+)/, 'Post'],
  [/^\/articles\/(\d+)/, 'Article'],
];

/**
 * A target for each URL: the entity it points to on Civitai when the path names one, or the bare URL
 * otherwise (a moderator resolves it). Only the path's leading id counts, so a version or query
 * string can't redirect it to something else.
 */
export function targetsFromUrls(urls: string[]) {
  return urls.map((url) => {
    let entityType: string | null = null;
    let entityId: number | null = null;
    try {
      const u = new URL(url);
      if (CIVITAI_HOSTS.has(u.hostname.toLowerCase()))
        for (const [re, type] of ENTITY_PATH) {
          const m = u.pathname.match(re);
          const id = m ? Number(m[1]) : NaN;
          if (Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647) {
            entityType = type;
            entityId = id;
            break;
          }
        }
    } catch {
      // checkIntakeValues already refused anything that isn't a URL.
    }
    return { url, entityType, entityId };
  });
}
