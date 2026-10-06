import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requesterTierLabel } from '../decisions';
import { stripComments } from '../../test/strip-comments';

/**
 * Every (tier, flag) pair the support router has actually written, plus the empty-tier "no signal"
 * value its schema allows. The flag is set for tier gold/silver OR a payment-domain topic, so a
 * free/bronze row carrying it is a payment-topic ticket, not a paying member.
 */
describe('requesterTierLabel', () => {
  it.each([
    ['free', false, 'tier: free'],
    ['free', true, 'tier: free · priority: payment topic'],
    ['bronze', false, 'tier: bronze'],
    ['bronze', true, 'tier: bronze · priority: payment topic'],
    ['silver', true, 'tier: silver · priority: paying member'],
    ['gold', true, 'tier: gold · priority: paying member'],
    [null, true, 'priority: payment topic'],
  ] as const)('tier %s, flag %s → %s', (tier, flag, expected) => {
    expect(requesterTierLabel(tier, flag)).toBe(expected);
  });

  it('renders nothing when there is neither a tier nor a flag', () => {
    expect(requesterTierLabel(null, false)).toBeNull();
  });
});

/**
 * ⚠️ TRIPWIRE, NOT COVERAGE: matches TEXT in the two `.svelte` pages (comments stripped). This app has
 * no Svelte render tier, so this is the only thing that fails if either page goes back to rendering
 * the tier and the flag itself instead of through the one formatter above.
 */
describe('both support pages render the requester through requesterTierLabel', () => {
  const routes = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../routes/decisions/support'
  );
  it.each(['ticket/[ticketId]/+page.svelte', '[groupKey]/+page.svelte'])('%s', (file) => {
    const src = stripComments(readFileSync(path.resolve(routes, file), 'utf-8'));
    expect(src).toContain('requesterTierLabel(');
    expect(src).not.toMatch(/\{\s*\w+\??\.memberTier\s*\}/);
    expect(src).not.toMatch(/paying priority/i);
  });
});
