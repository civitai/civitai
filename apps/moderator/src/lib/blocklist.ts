// The five blocklist types the moderator page manages (mirrors the main app's BlocklistType enum; the
// `Blocklist.type` column is a plain string, so there's no shared DB enum to import). Sorted for stable tabs.
export const BLOCKLIST_TYPES = [
  'EmailDomain',
  'LinkDomain',
  'MessagePattern',
  'UsernameExact',
  'UsernamePartial',
] as const;

export type BlocklistType = (typeof BLOCKLIST_TYPES)[number];

export const humanizeBlocklistType = (t: string) => t.replace(/([a-z])([A-Z])/g, '$1 $2');
