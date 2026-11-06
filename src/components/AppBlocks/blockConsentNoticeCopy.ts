import {
  blockScopePermissions,
  groupListingPermissions,
} from '~/components/Apps/listingPermissions';
import { SCOPE_PLAIN_TITLES } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * The sentence the missing-permissions notice (`BlockConsentNotice`) shows: WHAT will
 * not work, named from the missing scopes, rather than only "missing permissions".
 *
 * The scopes are grouped and ordered by `groupListingPermissions`, the one rule the
 * store listing and the consent screens use (sensitive first, then by OAuth bit), so
 * the notice names things in the same order the viewer then reads in the consent
 * modal. Only scopes with a plain-language title can be named: the titles are short
 * verb phrases ("Tip on your behalf") that read correctly after "can't". A scope
 * without one is not printed as a raw id; it still counts towards "and more".
 */

/** How many permissions the sentence names before it says "and more". */
export const CONSENT_NOTICE_MAX_NAMED = 2;

export function consentNoticeNamedActions(missingScopes: readonly string[] | undefined): {
  named: string[];
  more: boolean;
} {
  const unique = Array.from(new Set(missingScopes ?? []));
  const { sensitive, other } = groupListingPermissions(blockScopePermissions(unique));
  const ordered = [...sensitive, ...other];
  const titled = ordered.filter((p) =>
    Object.prototype.hasOwnProperty.call(SCOPE_PLAIN_TITLES, p.id)
  );
  // Nothing nameable: the caller falls back to the generic sentence, so there is no
  // "and more" to attach to.
  if (titled.length === 0) return { named: [], more: false };
  const named = titled.slice(0, CONSENT_NOTICE_MAX_NAMED).map((p) => lowerFirst(p.title));
  return { named, more: ordered.length > named.length };
}

/** The full sentence, e.g. "Tipper can't tip on your behalf or see your Buzz balance until you allow it." */
export function consentNoticeMessage(
  appName: string | undefined,
  missingScopes: readonly string[] | undefined
): string {
  const name = appName ?? 'This app';
  const { named, more } = consentNoticeNamedActions(missingScopes);
  if (named.length === 0) return `${name} is missing permissions it needs to work fully.`;
  let list: string;
  if (more) list = `${named.join(', ')} and more`;
  else if (named.length === 2) list = `${named[0]} or ${named[1]}`;
  else list = named[0];
  return `${name} can't ${list} until you allow it.`;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1);
}
