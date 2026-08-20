<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, num } from '$lib/format';
  import type { Jsonified } from '$lib/format';
  import type { Payout } from '$lib/server/user-account.service';

  let { userId }: { userId: number } = $props();

  const payouts = $derived(
    browser
      ? fetch(`/api/user-payouts/${userId}`).then(
          (r): Promise<{ items: Jsonified<Payout>[]; truncated: boolean }> =>
            r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
        )
      : null
  );

  // Anything that is not a completed transfer is what a moderator is looking for here — a rejected or
  // stuck payout is usually why the account is in front of them.
  const variant = (status: string) =>
    /reject|cancel|fail|error/i.test(status)
      ? ('destructive' as const)
      : /transferred|paid|complete/i.test(status)
        ? ('secondary' as const)
        : ('outline' as const);

  // Buzz requests are denominated in buzz; cash withdrawals are in cents. Rendering both as a bare
  // number would put "5000" next to "5000" for two very different amounts.
  const amount = (p: Jsonified<Payout>) =>
    p.kind === 'buzz' ? `${num(p.requested)} buzz` : `$${(p.requested / 100).toFixed(2)}`;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Payouts</h3>
  <p class="mb-3 text-xs text-dark-2">
    Withdrawal requests and their state. Tipalti is the processor, but every request is a row here, so
    this needs no connection to it.
  </p>

  {#await payouts}
    <p class="text-sm text-dark-2">Loading payouts…</p>
  {:then result}
    {#if result}
      {#if result.items.length === 0}
        <p class="text-sm text-dark-2">This account has never requested a payout.</p>
      {:else}
        <ul class="space-y-1.5 text-sm">
          {#each result.items as p (p.key)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <Badge variant={variant(p.status)}>{p.status}</Badge>
              <span class="text-dark-0">{amount(p)}</span>
              {#if p.transferred !== null && p.transferred !== p.requested}
                <span class="text-xs text-dark-2">transferred {num(p.transferred)}</span>
              {/if}
              {#if p.provider}<span class="text-xs text-dark-2">{p.provider}</span>{/if}
              <span class="text-xs text-dark-2">{dateTime(p.createdAt)}</span>
              {#if p.note}<span class="text-xs text-dark-2">— {p.note}</span>{/if}
            </li>
          {/each}
        </ul>
        {#if result.truncated}
          <p class="mt-2 text-xs text-amber-300">
            Capped at {result.items.length} — this account has more payouts than are shown.
          </p>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load payouts.</p>
  {/await}
</section>
