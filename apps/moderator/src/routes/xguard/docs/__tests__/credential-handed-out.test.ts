import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WHICH credential the XGuard docs tell an operator to ask for.
 *
 * 🔴 This page is the human distribution channel for a service token, so what it names is what
 * people end up holding. It told operators to ask for `WEBHOOK_TOKEN` — which this app accepts, so
 * nothing was broken and nothing failed — but that token is shared with the main app, while
 * `MOD_INBOUND_TOKEN` is accepted here and nowhere else. XGuard's API is an inbound-only consumer,
 * so every operator onboarded through this page was handed more reach than the job needs.
 *
 * 🔴 DELIBERATELY NOT `expect(page).not.toMatch(/WEBHOOK_TOKEN/)`. The page names the legacy token
 * on purpose, to say why it is the wrong one to hand out — a blanket ban on the word would fail on
 * the explanation and push a future editor to delete the very sentence that prevents the mistake.
 * (That exact trap cost two rounds elsewhere in this app: a guard forbidding a string failed on the
 * comment explaining the string.) Assert the INSTRUCTION and the COPY-PASTEABLE EXAMPLE — the two
 * things an operator actually acts on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, '../+page.svelte'), 'utf8');
const readme = readFileSync(join(HERE, '../../../../../xguard-lab/README.md'), 'utf8');

describe('the XGuard docs hand out the inbound-only token', () => {
  it('the "ask for" instruction names MOD_INBOUND_TOKEN', () => {
    const ask = /Ask a moderator admin for\s*<code[^>]*>([A-Z_]+)<\/code>/.exec(page);
    expect(ask, 'the getting-access step must still name a specific variable').toBeTruthy();
    expect(ask![1]).toBe('MOD_INBOUND_TOKEN');
  });

  it('the curl example an operator copies uses the same token', () => {
    // The instruction and the example are edited independently; one updated without the other
    // leaves the page telling you to ask for one credential and paste another.
    const curl = /curl -H "Authorization: Bearer \$([A-Z_]+)"/.exec(page);
    expect(curl, 'the page must still carry a copy-pasteable example').toBeTruthy();
    expect(curl![1]).toBe('MOD_INBOUND_TOKEN');
  });

  it('the lab README points the same way, and says why', () => {
    // Two surfaces, one instruction: an operator reaches either. The "why" is what stops the next
    // editor "simplifying" back to the shared token because both work.
    expect(readme).toMatch(/Hand out `MOD_INBOUND_TOKEN`, not `WEBHOOK_TOKEN`/);
    expect(readme, 'the reason must survive, not just the name').toMatch(/inbound-only/);
  });

  it('the page still explains that the legacy token also works', () => {
    // The positive half of the rule above. Deleting this explanation would make the page read as
    // "only MOD_INBOUND_TOKEN is accepted", which is false while compatibility lasts and would send
    // anyone debugging a working legacy caller down the wrong path.
    expect(page).toMatch(/WEBHOOK_TOKEN/);
  });
});
