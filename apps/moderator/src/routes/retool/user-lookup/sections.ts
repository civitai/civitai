// Retool's `navigation1` / `navigation3` widgets, which are the app's real table of contents: User
// Lookup was navigated sections, not one scrolling page.
//
// Order is Retool's, and the live sidebar puts Bulk Image Manager third — between Socials & Bio and
// Buzz. It links out to the standalone page rather than being a section here, because that page is
// where the batch actions and their confirmations live.

export type Section = { slug: string; label: string };

/** Sections that leave User Lookup. Rendered in the nav in place, carrying the account through. */
export type SectionLink = { href: (userId: number) => string; label: string };

export const SECTION_LINKS: Record<string, SectionLink> = {
  'bulk-image-manager': {
    label: 'Bulk Image Manager',
    href: (userId) => `/retool/bulk-image-manager?source=user&q=${userId}`,
  },
};

export const SECTIONS: Section[] = [
  { slug: 'basic', label: 'Basic User Information' },
  { slug: 'socials', label: 'Socials & Bio' },
  { slug: 'content', label: 'Content Overview' },
  { slug: 'buzz', label: 'Buzz' },
  { slug: 'prompts', label: 'Prompt Audit' },
  { slug: 'shop', label: 'Cosmetic Shop' },
  { slug: 'generation', label: 'Image Generation' },
  { slug: 'training', label: 'LoRA Training' },
  { slug: 'bounties', label: 'Bounties' },
  { slug: 'comments', label: 'Comments' },
  { slug: 'leaderboard', label: 'Leaderboard' },
  { slug: 'reports', label: 'Reports' },
  { slug: 'reviews', label: 'Reviews' },
  { slug: 'reactions', label: 'Reactions' },
  { slug: 'mod-activity', label: 'Moderation Activity' },
  { slug: 'chat', label: 'Chat (DMs)' },
  { slug: 'score', label: 'Civitai Score' },
];

/** Retool's second nav — the enforcement surface, kept visually separate from the read sections. */
export const ADMIN_SECTIONS: Section[] = [
  { slug: 'admin', label: 'Admin' },
  { slug: 'notes', label: 'Notes & Strikes' },
  { slug: 'notifications', label: 'Notifications' },
  { slug: 'mutes', label: 'Timed Mutes' },
];

export const ALL_SECTIONS = [...SECTIONS, ...ADMIN_SECTIONS];

export const DEFAULT_SECTION = SECTIONS[0].slug;

export const isSection = (slug: string) => ALL_SECTIONS.some((s) => s.slug === slug);
