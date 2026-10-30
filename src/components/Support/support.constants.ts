/**
 * The support destinations, in one place because the footer menu and the `/support`
 * page now both offer them and a divergence between the two is invisible until a
 * user lands on the wrong one.
 *
 * 🔴 `/bugs`, `/support-portal` and `/canny/bugs` are the SAME redirect in
 * `next.config.mjs` — all three land on the Freshdesk ticket portal. That is why the
 * support menu's "Report a bug" is NOT one of these: routing it here is the exact
 * behaviour the in-product feedback panel exists to replace.
 */
export const SUPPORT_LINKS = {
  educationHub: '/education',
  discord: '/discord',
  faq: 'https://education.civitai.com/civitai-faq',
  portal: '/support-portal',
  /** The ticket portal, reached only when the feedback panel is unavailable. */
  bugTicket: '/bugs',
} as const;
