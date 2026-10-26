import {
  MODEL_RULE_CATEGORIES,
  cleanReferenceRows,
  parseAliases,
  type ReferenceRow,
} from '$lib/model-rules';
import type { LabRuleOverride } from './types';

/** Rule edits live only in this browser, one entry per moderator, keyed by rule id (negative: new). */
export const ruleDraftsStorageKey = (moderatorId: number) =>
  `text-scan-lab:rule-drafts:${moderatorId}`;

/** A rule as the form edits it: aliases one per line, as typed. */
export type RuleFields = {
  subject: string;
  description: string;
  aliases: string;
  /** Empty for none. */
  category: string;
  references: ReferenceRow[];
  note: string;
};
/** `baseUpdatedAt`: the saved rule's `updatedAt` when the edit started; null for a new rule. */
export type RuleDraft = RuleFields & { baseUpdatedAt: string | null };
export type SavedRule = {
  id: number;
  legacy: boolean;
  subject: string;
  description: string;
  aliases: string[];
  category?: string;
  references?: { url: string; label?: string }[];
  note: string;
  enabled: boolean;
  updatedAt: Date | string;
};
export type SaveAllEntry = Omit<RuleFields, 'references'> & {
  references: { url: string; label?: string }[]; draftId: number; id?: number; baseUpdatedAt?: string };

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Drafts = Record<string, RuleDraft>;
export type RuleDraftsFields = { drafts: Drafts };

const TEXT_KEYS = ['subject', 'description', 'aliases', 'note'] as const;
export const EMPTY: RuleFields = {
  subject: '',
  description: '',
  aliases: '',
  category: '',
  references: [],
  note: '',
};

export const fieldsOf = (rule: SavedRule): RuleFields => ({
  subject: rule.subject,
  description: rule.description,
  aliases: rule.aliases.join('\n'),
  category: rule.category ?? '',
  references: (rule.references ?? []).map((r) => ({ url: r.url, label: r.label ?? '' })),
  note: rule.note,
});
const sameReferences = (a: ReferenceRow[], b: ReferenceRow[]) =>
  a.length === b.length && a.every((r, i) => r.url === b[i].url && r.label === b[i].label);
const sameFields = (a: RuleFields, b: RuleFields) =>
  TEXT_KEYS.every((k) => a[k] === b[k]) &&
  a.category === b.category &&
  sameReferences(a.references, b.references);
const isEmpty = (f: RuleFields) =>
  TEXT_KEYS.every((k) => !f[k].trim()) && !f.category && !f.references.some((r) => r.url.trim());
const isoOf = (value: Date | string) => new Date(value).toISOString();

const isDraft = (v: unknown): v is RuleDraft => {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    TEXT_KEYS.every((k) => typeof d[k] === 'string') &&
    (d.baseUpdatedAt === null || typeof d.baseUpdatedAt === 'string')
  );
};

// Drafts stored before category and references existed have neither.
const knownCategory = (value: unknown) =>
  MODEL_RULE_CATEGORIES.some((c) => c.value === value) ? (value as string) : '';
const storedReferences = (value: unknown): ReferenceRow[] =>
  Array.isArray(value)
    ? value.flatMap((r) =>
        r && typeof r.url === 'string'
          ? [{ url: r.url, label: typeof r.label === 'string' ? r.label : '' }]
          : []
      )
    : [];

/** Null when storage cannot be read at all, as opposed to holding nothing. */
function readStored(store: Store | null, key: string): Drafts | null {
  let raw: string | null;
  try {
    if (!store) return null;
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Drafts = {};
  for (const [id, v] of Object.entries(parsed))
    if (/^-?[1-9]\d*$/.test(id) && isDraft(v))
      out[id] = {
        subject: v.subject,
        description: v.description,
        aliases: v.aliases,
        category: knownCategory(v.category),
        references: storedReferences(v.references),
        note: v.note,
        baseUpdatedAt: v.baseUpdatedAt,
      };
  return out;
}

export class RuleDraftsState {
  #f: RuleDraftsFields;
  #store: Store | null;
  #key: string;
  // Changes storage refused (quota, private mode): re-applied over every read so they are never lost.
  #unstored: Record<string, RuleDraft | null> = {};

  constructor(fields: RuleDraftsFields, store: Store | null, key: string) {
    this.#f = fields;
    this.#store = store;
    this.#key = key;
  }

  reload() {
    const stored = readStored(this.#store, this.#key);
    if (stored) this.#f.drafts = this.#overlay(stored, this.#unstored);
  }

  /** New rules first (newest first), then saved rules by id. */
  get ids(): number[] {
    return Object.keys(this.#f.drafts)
      .map(Number)
      .sort((a, b) => a - b);
  }

  get(id: number): RuleDraft | undefined {
    return this.#f.drafts[String(id)];
  }

  fields(rule: SavedRule): RuleFields {
    return this.get(rule.id) ?? fieldsOf(rule);
  }

  isStale(rule: SavedRule): boolean {
    const draft = this.get(rule.id);
    return !!draft && draft.baseUpdatedAt !== null && draft.baseUpdatedAt !== isoOf(rule.updatedAt);
  }

  edit(rule: SavedRule, fields: RuleFields) {
    if (sameFields(fields, fieldsOf(rule))) return this.#write({ [rule.id]: null });
    this.#write({
      [rule.id]: {
        ...fields,
        baseUpdatedAt: this.get(rule.id)?.baseUpdatedAt ?? isoOf(rule.updatedAt),
      },
    });
  }

  editNew(id: number, fields: RuleFields) {
    this.#write({ [id]: { ...fields, baseUpdatedAt: null } });
  }

  /** Rebases a draft current on `before` onto `after` after this moderator's own toggle, so it does not read as someone else's save. */
  rebaseOwnWrite(before: SavedRule, after: SavedRule) {
    const draft = this.get(after.id);
    if (draft?.baseUpdatedAt === isoOf(before.updatedAt)) this.keepMine(after);
  }

  /** Keeps this edit over the newer saved rule: it is now written against it. */
  keepMine(rule: SavedRule) {
    const draft = this.get(rule.id);
    if (draft) this.#write({ [rule.id]: { ...draft, baseUpdatedAt: isoOf(rule.updatedAt) } });
  }

  /** A new, empty rule. Its id is below every id here and in storage, so two tabs never share one. */
  add(): number {
    const taken = Object.keys({ ...(readStored(this.#store, this.#key) ?? {}), ...this.#f.drafts });
    const id = Math.min(0, ...taken.map(Number)) - 1;
    this.#write({ [id]: { ...EMPTY, baseUpdatedAt: null } });
    return id;
  }

  drop(ids: readonly number[]) {
    if (ids.length) this.#write(Object.fromEntries(ids.map((id) => [id, null])));
  }

  /** Drops drafts of rules that no longer exist, and of rules whose saved text now equals the draft. */
  prune(rules: readonly SavedRule[]) {
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    this.drop(
      this.ids.filter((id) => {
        if (id < 0) return false;
        const rule = byId.get(id);
        return !rule || sameFields(this.get(id)!, fieldsOf(rule));
      })
    );
  }

  /** What a try sends: every drafted rule that can be judged, with its saved enabled state. */
  overrides(rules: readonly SavedRule[]): LabRuleOverride[] {
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    return this.ids.flatMap((id) => {
      const draft = this.get(id)!;
      const rule = byId.get(id);
      if ((id > 0 && !rule) || rule?.legacy || !draft.subject.trim()) return [];
      return [
        {
          id,
          subject: draft.subject.trim(),
          description: draft.description.trim(),
          aliases: parseAliases(draft.aliases),
          enabled: rule ? rule.enabled : true,
        },
      ];
    });
  }

  /** What Save all sends: every drafted rule except regex rules and new rules nobody typed into. */
  saveAllPayload(rules: readonly SavedRule[]): SaveAllEntry[] {
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    return this.ids.flatMap((id) => {
      const { baseUpdatedAt, ...fields } = this.get(id)!;
      const rule = byId.get(id);
      if ((id > 0 && !rule) || rule?.legacy || (id < 0 && isEmpty(fields))) return [];
      return [
        {
          draftId: id,
          ...(id > 0 ? { id } : {}),
          ...fields,
          references: cleanReferenceRows(fields.references),
          ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
        },
      ];
    });
  }

  #write(patch: Record<string, RuleDraft | null>) {
    const stored = readStored(this.#store, this.#key);
    const unstored = { ...this.#unstored, ...patch };
    const merged = this.#overlay(stored ?? this.#f.drafts, unstored);
    try {
      if (Object.keys(merged).length) this.#store?.setItem(this.#key, JSON.stringify(merged));
      else this.#store?.removeItem(this.#key);
      this.#unstored = {};
    } catch {
      this.#unstored = unstored;
    }
    this.#f.drafts = merged;
  }

  #overlay(base: Drafts, patch: Record<string, RuleDraft | null>): Drafts {
    const out: Drafts = { ...base };
    for (const [id, draft] of Object.entries(patch)) {
      if (draft) out[id] = draft;
      else delete out[id];
    }
    return out;
  }
}
