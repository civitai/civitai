/**
 * The service tiers Freshdesk's `sla` contact field holds (`FRESHDESK_TIER_VALUES` in the main app). A
 * ticket carries the requester's tier as a tag, written by a Freshdesk automation as "<Tier> Membership"
 * or "Free User", so the tier is the tag that starts with one of these and ends there or in that suffix.
 */
const TIER_TAG = /^(supporter|bronze|silver|gold|buzz purchaser|free)(\s+(membership|user))?$/i;

/** Splits a ticket's tags into the requester's tier (the first tier tag) and everything else. */
export function splitTags(tags: readonly string[]): { tier: string | null; rest: string[] } {
  const at = tags.findIndex((t) => TIER_TAG.test(t));
  if (at === -1) return { tier: null, rest: [...tags] };
  return { tier: tags[at], rest: tags.filter((_, i) => i !== at) };
}
