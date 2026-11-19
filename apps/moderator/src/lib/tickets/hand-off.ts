/** The moderation view's hand-offs, in the order the card shows them. Each is a form action in `$lib/server/tickets/actions`. */
export type HandOffRoute = {
  action: 'fileBug' | 'privacy' | 'modLead' | 'escalate';
  label: string;
  confirm: string;
  yes: string;
  done: string;
  /** The note is the report itself, so it cannot be empty. */
  needsNote?: boolean;
};

const ROUTES: HandOffRoute[] = [
  {
    action: 'fileBug',
    label: 'Bug → dev queue…',
    confirm:
      'Files a bug report for the dev team from your note. The ticket stays here: reply to it or close it as usual.',
    yes: 'Yes, file the bug',
    done: 'Bug report filed',
    needsNote: true,
  },
  {
    action: 'privacy',
    label: 'Privacy / account deletion…',
    confirm:
      "Emails the requester Legal's acknowledgment and hands the ticket to Legal; it leaves both ticket views. Not for takedowns (DMCA, TAKE IT DOWN, likeness), law enforcement or CSAM.",
    yes: 'Yes, send to Legal',
    done: 'Sent to Legal',
  },
  {
    action: 'modLead',
    label: 'Mod lead…',
    confirm: 'Sets "Waiting on Mod Lead" for the mod lead to pick up. Nothing is emailed.',
    yes: 'Yes, send to the mod lead',
    done: 'Sent to the mod lead',
  },
  {
    action: 'escalate',
    label: 'Send to support…',
    confirm: "Nothing is emailed, but the ticket leaves the moderators' queue.",
    yes: 'Yes, send to support',
    done: 'Sent to support',
  },
];

/** The routes a moderator is shown. Privacy has its own grant and ships dark: without it, it is absent, not disabled. */
export const handOffRoutes = (canPrivacy: boolean): HandOffRoute[] =>
  ROUTES.filter((r) => r.action !== 'privacy' || canPrivacy);
