import { TRPCError } from '@trpc/server';
import {
  MAX_PATTERNED_INPUT_LEN,
  type ManifestSettings,
  type ManifestSettingField,
} from '~/server/schema/blocks/manifest-settings.meta.schema';

/**
 * W3 v0 generic settings validator. Replaces the per-block-id schema map
 * that lived in `settings.schema.ts` — the manifest is now the source of
 * truth for what fields a block exposes, and this validator enforces the
 * declared shape at every call site that writes user-supplied settings.
 *
 * Pattern: the call site forwards the app's `manifest.settings` (already
 * validated against `manifestSettingsSchema` at submission time) + the
 * incoming `inputSettings` payload + the app's declared scopes + which side
 * of the settings split is being written (publisher install row vs viewer
 * override row).
 *
 * Behavior summary:
 *  - Wrong-scope fields are silently skipped (lets the same call validate
 *    either side without callers filtering up front).
 *  - `requires_scope`-gated fields whose scope the app didn't declare are
 *    silently skipped (the field doesn't exist for this app).
 *  - Missing fields with a declared `default` get the default in the output.
 *  - Missing fields without a default are omitted (caller's storage retains
 *    whatever was there before; with persistence at the SQL UPDATE level
 *    this means the JSONB column merges).
 *  - Unknown keys in `inputSettings` are stripped silently — never echo
 *    them back into storage. Don't leak which keys are unrecognized; a
 *    malformed update could be a probe.
 *  - Type or range failures throw `TRPCError(BAD_REQUEST)` keyed to the
 *    offending field so the install-form UI can surface it inline.
 *
 * Cross-row validation (e.g. "the resource_picker value points at a model
 * version that exists + is in the LoRA's ecosystem") is the caller's
 * responsibility — this layer only enforces what the manifest declared
 * statically. The checkpoint service still owns that piece.
 */

export type SettingsScope = 'publisher' | 'viewer';

export interface ValidateBlockSettingsOptions {
  manifestSettings: ManifestSettings;
  inputSettings: Record<string, unknown>;
  /** App's declared scopes (from manifest). Drives `requires_scope` gating. */
  declaredScopes: string[];
  forScope: SettingsScope;
}

export function validateBlockSettings(
  opts: ValidateBlockSettingsOptions
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, fieldDef] of Object.entries(opts.manifestSettings)) {
    if (fieldDef.scope !== opts.forScope) continue;

    if (fieldDef.requires_scope && !opts.declaredScopes.includes(fieldDef.requires_scope)) {
      continue;
    }

    const hasInput = Object.prototype.hasOwnProperty.call(opts.inputSettings, key);
    const raw = hasInput ? opts.inputSettings[key] : undefined;

    // Explicit `null` is a clear signal — let it through to storage as-is
    // when the field declares a nullable default. Otherwise (the field
    // wasn't supplied), fall back to the manifest default.
    if (raw === undefined || (raw === null && fieldDef.default !== null)) {
      if (fieldDef.default !== undefined) {
        out[key] = fieldDef.default;
      }
      continue;
    }

    if (raw === null) {
      // Field declares `default: null` (e.g. checkpoint picker not yet set).
      out[key] = null;
      continue;
    }

    out[key] = validateField(key, fieldDef, raw);
  }

  return out;
}

function validateField(key: string, def: ManifestSettingField, raw: unknown): unknown {
  switch (def.type) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: must be a finite number`,
        });
      }
      if (def.min !== undefined && raw < def.min) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: must be >= ${def.min}`,
        });
      }
      if (def.max !== undefined && raw > def.max) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: must be <= ${def.max}`,
        });
      }
      return raw;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: must be a string`,
        });
      }
      if (def.max_length !== undefined && raw.length > def.max_length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: exceeds max length ${def.max_length}`,
        });
      }
      if (def.pattern) {
        // Defense-in-depth: `def.pattern` is app-developer-authored and only
        // mod-reviewed. The submission gate (BlockManifestValidator.validateSubmission)
        // now rejects ReDoS-vulnerable patterns AND forces a patterned field to
        // declare `max_length <= MAX_PATTERNED_INPUT_LEN` — but a pattern STORED
        // before that gate existed could lack a max_length, leaving `raw` unbounded.
        // Hard-cap the input the regex sees regardless, so a viewer can't feed
        // a long string into a (legacy) pathological pattern and freeze the
        // event loop. This tames polynomial patterns fully; exponential ones
        // are the submission gate's job (an input cap can't save you there).
        if (raw.length > MAX_PATTERNED_INPUT_LEN) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `settings.${key}: exceeds max length ${MAX_PATTERNED_INPUT_LEN}`,
          });
        }
        if (!new RegExp(def.pattern).test(raw)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `settings.${key}: format invalid`,
          });
        }
      }
      if (def.enum && !def.enum.includes(raw)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: not in allowed values`,
        });
      }
      return raw;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `settings.${key}: must be a boolean`,
        });
      }
      return raw;
    }
  }
}
