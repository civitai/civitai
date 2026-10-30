import { describe, expect, it } from 'vitest';
import { assistantSystemPrompt } from '@civitai/app-assistant';
import { APP_ASSISTANT_RULES } from '~/components/Apps/AppAssistant/assistantInstructions';

/**
 * What the assistant is told it can build with, pinned word for word: each sentence below was missing
 * or wrong in a live run, and the assistant acted on the gap (it told a user Civitai has no
 * transaction history; it shipped a price reading "104 Buzz Buzz").
 */

/** The rules each runner sends: the page's system prompt, and the server runner's. */
const PROMPTS = {
  browser: APP_ASSISTANT_RULES,
  remote: assistantSystemPrompt('remote', false)('Chat defaults.'),
};

const BUZZ_TRANSACTIONS =
  "- The viewer's own Buzz transactions (a spending history, a daily spending chart) are available: import { getTransport } from '@civitai/sdk' and call getTransport().request('GET_BUZZ_TRANSACTIONS', { params: { accountType, type, start, end, cursor, limit } }), which resolves to { transactions, cursor } (each transaction has date, a Date or an ISO string, so read it with new Date(date); type; amount, always positive, spent or received as its fromAccountId and toAccountId say; and description. limit is 1-200, 50 by default; pass the returned cursor to get the next page). It needs the buzz:read:self scope in block.manifest.json. Each call reads one Buzz pool: accountType is 'yellow' unless you pass another ('blue', 'green'), so request every pool the app shows and combine them. BREAKING.md's \"No v1 route\" for GET_BUZZ_TRANSACTIONS means only that app.site has no route for it; this host request works.";

const PRICE =
  "- Price a generation with estimatedCost(estimate) from @civitai/sdk where the installed version exports it; otherwise an estimate is priced when its status is not 'failed' and cost.total is a number (0 is a price), and that number is the price. A priced estimate comes back 'pending', not 'succeeded': never require 'succeeded'. The price is a bare number of Buzz: write the word Buzz once beside it (`${price} Buzz`), never also inside a helper that formats it, or the app shows \"104 Buzz Buzz\".";

describe.each(Object.entries(PROMPTS))('the %s runner’s rules', (_, prompt) => {
  it('tell the assistant the viewer’s Buzz transactions are readable, one pool per request', () => {
    expect(prompt.split('\n')).toContain(BUZZ_TRANSACTIONS);
  });

  it('tell the assistant a price is a bare number, so the unit is written once', () => {
    expect(prompt.split('\n')).toContain(PRICE);
  });
});
