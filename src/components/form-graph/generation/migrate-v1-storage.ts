import { scopedAddress } from 'form-graph';
import { ecosystemByKey, ecosystemGroups } from '~/shared/constants/basemodel.constants';

/**
 * One-time carry-over of a user's v1 generation-form state into the
 * form-graph store. Deliberately partial: only the fields worth preserving
 * (prompt/negativePrompt, outputFormat, priority, quantity, workflow,
 * per-output ecosystem, per-family model + resources) — everything else
 * starts fresh. Values are copied raw; the hub's input schemas validate them
 * on first parse, so a stale or malformed v1 value degrades to the default
 * rather than breaking the form.
 *
 * v1's records are left untouched: while the flag rolls out, sessions without
 * it still run GenerationFormV2 against them.
 */

const V1_KEY = 'generation-graph';
const OUTPUT_TYPES = ['image', 'video', 'audio', 'model3d'] as const;

function readRecord(
  read: (key: string) => string | null,
  key: string
): Record<string, unknown> | undefined {
  const raw = read(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The intent record to seed the form-graph store with, or undefined if v1 holds nothing. */
export function buildV1MigrationIntent(
  read: (key: string) => string | null
): Record<string, unknown> | undefined {
  const intent: Record<string, unknown> = {};
  const take = (source: Record<string, unknown> | undefined, key: string, address = key) => {
    const value = source?.[key];
    if (value !== undefined) intent[address] = value;
  };

  const global = readRecord(read, V1_KEY);
  take(global, 'workflow');
  take(global, 'prompt');
  take(global, 'negativePrompt');
  take(global, 'quantity');

  const preferences = readRecord(read, `${V1_KEY}.preferences`);
  take(preferences, 'outputFormat');
  take(preferences, 'priority');

  const draft = readRecord(read, `${V1_KEY}.workflow.txt2img:draft`);
  take(draft, 'quantity', scopedAddress('quantity', 'txt2img:draft'));

  for (const output of OUTPUT_TYPES) {
    const record = readRecord(read, `${V1_KEY}.output.${output}`);
    take(record, 'ecosystem', scopedAddress('ecosystem', output));
  }

  // Same bucket keys on both sides: grouped ecosystems store under the group
  // id, standalone ones under their own key (v1's adapter groups; the port's
  // familyScope).
  const familyKeys = new Set<string>([
    ...ecosystemGroups.map((group) => group.id),
    ...ecosystemByKey.keys(),
  ]);
  for (const familyKey of familyKeys) {
    const record = readRecord(read, `${V1_KEY}.ecosystem.${familyKey}`);
    take(record, 'model', scopedAddress('model', familyKey));
    take(record, 'resources', scopedAddress('resources', familyKey));
  }

  return Object.keys(intent).length ? intent : undefined;
}

/**
 * Runs the migration against localStorage, once: a no-op whenever the
 * form-graph record already exists (including from a previous migration).
 */
export function migrateV1GenerationStorage(targetKey: string) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(targetKey) !== null) return;
    const intent = buildV1MigrationIntent((key) => localStorage.getItem(key));
    if (intent) localStorage.setItem(targetKey, JSON.stringify(intent));
  } catch {
    // Quota/privacy-mode failures: start fresh instead.
  }
}
