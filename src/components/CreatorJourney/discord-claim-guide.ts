/** Tiers whose badge earns a role on the Civitai Discord (`applyDiscordCreatorJourneyRoles`). */
export const discordRoleTiers = ['supernova', 'legend'] as const;
export type DiscordRoleTier = (typeof discordRoleTiers)[number];

export const CIVITAI_DISCORD_INVITE = 'https://discord.gg/civitai';
export const DISCORD_LINK_ROLE_HREF = '/discord/link-role';

/** The ladder reward line for each Discord role, keyed by tier key; `tierRewards` lists the same text. */
export const discordRoleRewards: Record<string, { tier: DiscordRoleTier; line: string }> = {
  'score:supernova': { tier: 'supernova', line: 'A Supernova role on our Discord' },
  'score:legend': { tier: 'legend', line: 'A Legend role and the #legends channel on our Discord' },
};

/** Opens the how-to-claim guide on the journey page: `?discord=legend`. */
export const DISCORD_CLAIM_PARAM = 'discord';

export const discordClaimGuideHref = (tier: DiscordRoleTier) =>
  `/creators/journey?${DISCORD_CLAIM_PARAM}=${tier}`;

/** The guide a `?discord=` value asks for, or null for a missing, repeated or unknown value. */
export function discordClaimGuideFromQuery(value: string | string[] | undefined) {
  if (typeof value !== 'string') return null;
  return (discordRoleTiers as readonly string[]).includes(value)
    ? (value as DiscordRoleTier)
    : null;
}
