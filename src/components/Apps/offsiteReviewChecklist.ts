import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';

/**
 * App Store Listings (W13) — P3a kind-aware mod-review checklist (PURE view-model).
 *
 * The `/apps/review` Pending queue is kind-aware: an ON-SITE (App Block) request
 * gets the deep code/bundle/manifest/scopes review the existing modal already
 * renders; an OFF-SITE (external-link) request gets a LIGHTER, content-only
 * checklist (no code to read — the app runs off-platform). This module is the
 * single source of truth for WHICH checklist items apply to WHICH kind, extracted
 * so the mapping is unit-testable without mounting the review page.
 *
 * `status` is AUTO-DERIVED where the request payload makes it deterministic (name
 * present, https URL, asset presence) and left `'todo'` for the items that need a
 * moderator's judgment (description not spam/phishing, category correct, and every
 * on-site code item). The UI renders `ok`/`warn` as a computed check and `todo` as
 * an un-ticked box the mod eyeballs.
 */

export type ReviewChecklistKind = 'onsite' | 'offsite';

/** `ok` = auto-verified pass · `warn` = auto-detected problem · `todo` = mod judgment. */
export type ReviewChecklistItemStatus = 'ok' | 'warn' | 'todo';

export type ReviewChecklistItem = {
  /** Stable id (test + React key). */
  id: string;
  label: string;
  hint: string;
  status: ReviewChecklistItemStatus;
};

/** The off-site listing facts the content checklist derives its auto-checks from. */
export type OffsiteChecklistData = {
  name: string | null | undefined;
  externalUrl: string | null | undefined;
  hasIcon: boolean;
  hasCover: boolean;
  screenshotCount: number;
  category: string | null | undefined;
  description: string | null | undefined;
};

/**
 * The deep ON-SITE (App Block) review checklist. These items are STATIC reminders
 * of the code/bundle review the mod performs in the existing modal panels — the
 * off-site content checklist deliberately OMITS every one of them (there is no
 * bundle / manifest / scopes / code to read for an external-link app).
 */
export function getOnsiteReviewChecklist(): ReviewChecklistItem[] {
  return [
    {
      id: 'code-diff',
      label: 'Code diff reviewed',
      hint: 'Read the line-level diff / bundle contents for anything malicious or broken.',
      status: 'todo',
    },
    {
      id: 'bundle',
      label: 'Bundle contents reviewed',
      hint: 'The submitted files match the declared app; no unexpected payloads.',
      status: 'todo',
    },
    {
      id: 'manifest',
      label: 'Manifest + slot targets reviewed',
      hint: 'Declared slots, render mode and settings are appropriate.',
      status: 'todo',
    },
    {
      id: 'scopes',
      label: 'Requested JWT scopes justified',
      hint: 'Every requested scope is needed for the stated functionality.',
      status: 'todo',
    },
    {
      id: 'screenshots',
      label: 'Screenshots reviewed',
      hint: 'Publisher-supplied imagery is on-brand and not abusive.',
      status: 'todo',
    },
  ];
}

/**
 * The lighter, content-only OFF-SITE (external-link) review checklist. Auto-checks
 * the deterministic facts (name present, https URL, icon/cover/≥1 screenshot
 * present) and leaves the judgment items (`description` not spam/phishing,
 * `category` correct) as `todo`. Contains NONE of the on-site code/bundle items.
 */
export function getOffsiteReviewChecklist(data: OffsiteChecklistData): ReviewChecklistItem[] {
  const namePresent = typeof data.name === 'string' && data.name.trim().length > 0;
  const urlValid = validateExternalUrl(data.externalUrl).ok;
  const screenshotOk = data.screenshotCount >= 1;
  return [
    {
      id: 'name',
      label: 'Name present',
      hint: 'The listing has a non-empty display name.',
      status: namePresent ? 'ok' : 'warn',
    },
    {
      id: 'url-https',
      label: 'URL is https and opens externally',
      hint: 'The target is a valid https:// URL rendered with target="_blank" rel="noopener".',
      status: urlValid ? 'ok' : 'warn',
    },
    {
      id: 'icon',
      label: 'Icon present',
      hint: 'An icon asset is attached to the draft listing.',
      status: data.hasIcon ? 'ok' : 'warn',
    },
    {
      id: 'cover',
      label: 'Cover present',
      hint: 'A cover asset is attached to the draft listing.',
      status: data.hasCover ? 'ok' : 'warn',
    },
    {
      id: 'screenshots',
      label: 'At least one screenshot',
      hint: 'The draft listing has one or more real screenshots.',
      status: screenshotOk ? 'ok' : 'warn',
    },
    {
      id: 'description',
      label: 'Description is not spam or phishing',
      hint: 'Read the description + tagline for spam, phishing or impersonation.',
      status: 'todo',
    },
    {
      id: 'category',
      label: 'Category is correct',
      hint: 'The declared category matches what the app actually does.',
      status: 'todo',
    },
  ];
}

/**
 * Kind-aware dispatcher: the deep on-site checklist for `kind='onsite'`, the
 * content-only off-site checklist for `kind='offsite'`. The off-site branch needs
 * the listing facts; the on-site branch is static.
 */
export function getReviewChecklist(
  kind: ReviewChecklistKind,
  data?: OffsiteChecklistData
): ReviewChecklistItem[] {
  if (kind === 'onsite') return getOnsiteReviewChecklist();
  return getOffsiteReviewChecklist(
    data ?? {
      name: null,
      externalUrl: null,
      hasIcon: false,
      hasCover: false,
      screenshotCount: 0,
      category: null,
      description: null,
    }
  );
}
