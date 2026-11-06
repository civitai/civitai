/**
 * What the opt-in prompt says we would push, one row per group of default push types. Pinned to
 * `DEFAULT_PUSH_TYPES` by push-prompt-rows.test.ts, so the prompt never promises a push that is
 * off by default, nor leaves a default out.
 */
export const PUSH_PROMPT_ROWS = [
  {
    key: 'replies',
    label: 'Replies and @mentions',
    description: 'When someone replies to your comment or mentions you',
    types: ['new-mention', 'new-comment-response', 'new-comment-reply'],
  },
  {
    key: 'tips',
    label: 'Tips',
    description: 'When someone tips you Buzz',
    types: ['tip-received'],
  },
  {
    key: 'services',
    label: 'Creator Services',
    description: 'New requests, deliveries and payouts on your deals',
    types: [
      'service-deal-requested',
      'service-deal-accepted',
      'service-deal-declined',
      'service-deal-expired',
      'service-deal-delivered',
      'service-deal-revision-requested',
      'service-deal-cancellation-requested',
      'service-deal-completed',
      'service-deal-paid-out',
    ],
  },
  {
    key: 'events',
    label: 'Event reminders',
    description: "Like when your Birthday hat isn't on anything yet",
    types: ['event-reminder'],
    isNew: true,
  },
] as const satisfies readonly {
  key: string;
  label: string;
  description: string;
  types: readonly string[];
  isNew?: boolean;
}[];

export type PushPromptRow = (typeof PUSH_PROMPT_ROWS)[number];

/** The rows a user already gets pushed, from their push settings. */
export function rowsForPushTypes(types: readonly string[]) {
  const on = new Set(types);
  return PUSH_PROMPT_ROWS.filter((row) => row.types.some((t) => on.has(t)));
}
