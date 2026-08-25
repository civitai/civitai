/**
 * The comment-spam signature.
 *
 * Measured 2026-08-24 over 90 days of ClickHouse comment events against ban outcomes. The account's
 * AGE is what discriminates, and it is the whole of the discrimination:
 *
 *   >=10 comments in an hour, any age .................. 1,086 accounts, 76.5% banned
 *   >=10 comments in an hour, account < 2 days old ....... 837 accounts, 98.9% banned
 *   >=10 comments in an hour, account >= 2 days old ...... 249 accounts,  1.2% banned
 *
 * So a volume-only rule points at 249 established accounts having an argument. There is deliberately
 * no "distinct targets" condition: the ClickHouse `comments` table records `entityId` as the COMMENT's
 * own id for every type except `Model`, so a distinct-target count is identical to the comment count
 * and measures nothing. Fixing that is a tracker change in the main app.
 */
export const COMMENT_SPAM = { minComments: 10, maxAccountAgeDays: 2 } as const;
