// The one-time "What's new" dialog shown to members after the v2 launch (`WhatsNewDialog.svelte`). All its copy is here.

/** Filled at launch with the announcement article's URL; the dialog's link shows only once it is set. */
export const ANNOUNCEMENT_URL = '';

/** `link` turns that part of the lead-in into a link. */
export type WhatsNewItem = { lead: string; body: string; link?: { text: string; href: string } };
export type WhatsNew = { eyebrow: string; title: string; lead: string; items: WhatsNewItem[] };

const SHOP: WhatsNewItem = {
  lead: 'Earn gold, spend it in the shop.',
  body: 'Judging well pays gold. Trade it for Buzz, Knights-only cosmetics or a week of membership perks.',
};
const WATCH: WhatsNewItem = {
  lead: 'Keep the Watch.',
  body: 'Judge 30 images a day to complete your Watch, build a streak for bonus gold, and get one free shield a week for a missed day.',
};
const CODEX: WhatsNewItem = {
  lead: 'Everything is in the Codex.',
  body: 'Ranks, the daily loop and the rating guide, all in one place.',
  link: { text: 'Codex', href: '/codex' },
};

// A newcomer never saw the old game, so their version talks about how the Order works, not what changed.
const RETURNING_COPY: WhatsNew = {
  eyebrow: "What's new",
  title: 'Welcome to the new Knights of New Order',
  lead: "The Order has a new home. Here's what changed:",
  items: [
    { lead: 'Your rank and XP came with you.', body: 'Pick up where you left off.' },
    SHOP,
    WATCH,
    {
      lead: 'Climb higher.',
      body: 'A new rank sits above Templar: Paladin, with its own golden badge.',
    },
    CODEX,
  ],
};
const NEWCOMER_COPY: WhatsNew = {
  eyebrow: 'Before you begin',
  title: 'Welcome to the Knights of New Order',
  lead: "Here's how the Order works:",
  items: [
    {
      lead: 'You start as an Acolyte.',
      body: 'Practise on images with known answers until you reach Knight at level 20.',
    },
    SHOP,
    WATCH,
    { lead: 'Climb the ranks.', body: 'Knight, Templar, then Paladin, each with its own badge.' },
    CODEX,
  ],
};

/** A player with v1 progress: any XP (level 1 starts at 0 XP), or a rank above Acolyte. */
export const isReturningPlayer = (status: { rank: string; level: number; xpIntoLevel: number }) =>
  status.rank !== 'Acolyte' || status.level > 1 || status.xpIntoLevel > 0;

export const whatsNewCopy = (returning: boolean): WhatsNew =>
  returning ? RETURNING_COPY : NEWCOMER_COPY;
