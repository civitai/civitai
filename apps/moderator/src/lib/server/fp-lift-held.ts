/** What a moderator is told when a Feature Pages comment cannot be shown again, for the holds every lift shares. */
export const FP_LIFT_HELD = {
  foreign: 'It was hidden by another action on the platform first, so it stays hidden.',
  pushing: 'This comment is being sent to the platform. Try again in a minute.',
  author: "The comment's author is banned or muted, so it stays hidden.",
  held: 'This comment is held for a child-safety check, so it stays hidden.',
} as const;
