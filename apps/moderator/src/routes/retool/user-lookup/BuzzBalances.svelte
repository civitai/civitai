<script lang="ts">
  import { num } from '$lib/format';
  import type { Account } from './user-account';

  let { account }: { account: Promise<Account> | null } = $props();

  // Retool showed the three balances as coloured headings on the left and their lifetime totals on the
  // right, on both Buzz tabs — the colour IS the identifier a moderator reads by.
  const ROWS = [
    { key: 'yellow', label: 'Yellow', class: 'text-amber-400' },
    { key: 'blue', label: 'Blue', class: 'text-blue-400' },
    { key: 'green', label: 'Green', class: 'text-emerald-400' },
  ] as const;

  const balances = (buzz: NonNullable<Account['buzz']>) => [
    { ...ROWS[0], balance: buzz.balance, lifetime: buzz.lifetimeBalance },
    { ...ROWS[1], balance: buzz.blue, lifetime: buzz.blueLifetime },
    { ...ROWS[2], balance: buzz.green, lifetime: buzz.greenLifetime },
  ];

  const value = (n: number | null) => (n === null ? '—' : num(n));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  {#await account}
    <p class="text-sm text-dark-2">Loading balance…</p>
  {:then result}
    {#if !result}
      <p class="text-sm text-dark-2">Loading balance…</p>
    {:else if !result.buzz}
      <p class="text-sm text-dark-2">Balance unavailable.</p>
    {:else}
      <div class="flex flex-wrap justify-between gap-x-10 gap-y-2">
        <div class="space-y-1">
          {#each balances(result.buzz) as row (row.key)}
            <div class="text-lg font-semibold tabular-nums {row.class}">
              {row.label} Buzz Balance: {value(row.balance)}
            </div>
          {/each}
        </div>
        <div class="space-y-1 text-right">
          {#each balances(result.buzz) as row (row.key)}
            <div class="text-lg font-semibold tabular-nums text-white">
              Lifetime {row.label} Buzz Balance: {value(row.lifetime)}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load Buzz balance.</p>
  {/await}
</section>
