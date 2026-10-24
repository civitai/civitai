import { parsePlatformFeedbackVersion } from '@civitai/shared/platform-feedback-version';
import { sql, type RawBuilder } from '@civitai/db/kysely';
// Relative, not `$lib`: imported by the main app's moderator-seam test.
import {
  PLATFORM_FIXED_IN_COMPONENTS,
  PLATFORM_FIXED_IN_VERSION_MAX_LENGTH,
  PLATFORM_PUBLIC_NOTE_MAX_LENGTH,
  type PlatformFixedInComponent,
} from '../feedback-platform';

/**
 * What a moderator writes to `context.server.resolution` on an `apps-platform` row — the part of the
 * row read back through `platformFeedback.getStatus` — by the reporters, and by anyone who can
 * rebuild a ref-keyed report's ref from its failure site:
 *   - `actioned` with a non-blank `fixedIn.version` reads back as `fixed`, without one as `addressed`;
 *   - `publicNote` is returned to the agents verbatim, at any status.
 */

// A NUL or an unpaired surrogate: Postgres stores neither in `jsonb`, so the write would 500.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isUnstorable = (text: string) => text.includes('\u0000') || LONE_SURROGATE.test(text);

export type PlatformResolutionWrite = {
  /**
   * The stored `resolution.at` the operator was looking at, `null` for none. The UPDATE is scoped on
   * it, as the status change is on `expectedStatus`: without it, two moderators editing one
   * resolution would each see "saved" while the second silently replaced the first.
   */
  expectedAt: string | null;
} & (
  | { kind: 'clear' }
  | {
      kind: 'set';
      fixedIn: { component: PlatformFixedInComponent; version: string } | null;
      publicNote: string | null;
    }
);

const isComponent = (value: string): value is PlatformFixedInComponent =>
  (PLATFORM_FIXED_IN_COMPONENTS as readonly string[]).includes(value);

/**
 * The triage form's resolution fields, validated. `value: undefined` means the form asked for no
 * resolution change, which is every form except the platform panel's resolution forms.
 */
export function parsePlatformResolutionForm(input: {
  resolution?: 'set' | 'clear';
  expectedResolutionAt?: string;
  fixedInComponent?: string;
  fixedInVersion?: string;
  publicNote?: string;
}): { ok: true; value: PlatformResolutionWrite | undefined } | { ok: false; error: string } {
  const component = input.fixedInComponent?.trim() ?? '';
  const version = input.fixedInVersion?.trim() ?? '';
  const note = input.publicNote?.trim() ?? '';

  if (input.resolution === undefined) {
    // A field posted without the mode would be silently ignored, which reads as saved.
    return component || version || note
      ? { ok: false, error: 'Resolution fields were sent without saying what to do with them.' }
      : { ok: true, value: undefined };
  }
  if (input.expectedResolutionAt === undefined)
    return { ok: false, error: 'This form is missing the resolution it was editing. Reload it.' };
  const expectedAt = input.expectedResolutionAt || null;
  if (input.resolution === 'clear') return { ok: true, value: { kind: 'clear', expectedAt } };

  if (component && !isComponent(component))
    return { ok: false, error: 'Pick a component from the list.' };
  if (version && !component)
    return { ok: false, error: 'Pick the component the version belongs to.' };
  if (version.length > PLATFORM_FIXED_IN_VERSION_MAX_LENGTH)
    return {
      ok: false,
      error: `A version is at most ${PLATFORM_FIXED_IN_VERSION_MAX_LENGTH} characters.`,
    };
  if (version && !parsePlatformFeedbackVersion(version))
    return {
      ok: false,
      error: 'That version does not parse — use a release number like 2.4.0, v2.4 or 2.',
    };
  if (note.length > PLATFORM_PUBLIC_NOTE_MAX_LENGTH)
    return {
      ok: false,
      error: `The public note is at most ${PLATFORM_PUBLIC_NOTE_MAX_LENGTH} characters.`,
    };
  if (isUnstorable(note))
    return { ok: false, error: 'The public note contains a character that cannot be stored.' };
  if (!component && !note)
    return {
      ok: false,
      error: 'Pick what it was fixed in or write a public note — or use Clear resolution.',
    };

  return {
    ok: true,
    value: {
      kind: 'set',
      expectedAt,
      fixedIn: isComponent(component) ? { component, version } : null,
      publicNote: note || null,
    },
  };
}

/** The object stored at `context.server.resolution`. `at` and `byId` are never taken from the form. */
export function storedPlatformResolution(
  write: Extract<PlatformResolutionWrite, { kind: 'set' }>,
  by: { moderatorId: number; at: Date }
) {
  return {
    ...(write.fixedIn ? { fixedIn: write.fixedIn } : {}),
    ...(write.publicNote ? { publicNote: write.publicNote } : {}),
    at: by.at.toISOString(),
    byId: by.moderatorId,
  };
}

/**
 * The new value of the `context` column, as ONE expression over the row's current value.
 *
 * 🔴 NEVER A READ-MODIFY-WRITE OF `context`. The platform-feedback service counts repeat reports into
 * `context.server` with its own single-statement `jsonb_set`, so writing back a `context` read
 * earlier would erase every count that landed in between. This touches the `resolution` key only.
 */
export function platformResolutionContext(
  write: PlatformResolutionWrite,
  by: { moderatorId: number; at: Date }
): RawBuilder<unknown> {
  if (write.kind === 'clear') return sql`${sql.ref('context')} #- '{server,resolution}'`;
  const stored = JSON.stringify(storedPlatformResolution(write, by));
  return sql`jsonb_set(${sql.ref('context')}, '{server,resolution}', ${stored}::jsonb)`;
}
