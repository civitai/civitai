// The signature's thresholds, shared with the page that quotes them in its copy. The server half
// (`$lib/server/comment-spam.service.ts`) re-exports these rather than declaring its own, so the
// sentence a moderator reads and the rule that produced the list cannot drift apart.
export const COMMENT_SPAM = { minComments: 10, minTargets: 10, maxAccountAgeDays: 2 } as const;
