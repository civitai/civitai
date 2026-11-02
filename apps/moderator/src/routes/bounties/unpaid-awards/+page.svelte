<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { BountyAwardRuling } from '@civitai/shared/bounty-award';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { bountyUrl, userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const RULINGS: { value: BountyAwardRuling; label: string; hint: string }[] = [
    { value: 'paid_winner', label: 'Paid to the winner', hint: 'The ledger shows the winner received it.' },
    {
      value: 'refunded_supporter',
      label: 'Refunded to the supporter',
      hint: 'The ledger shows the supporter got it back.',
    },
    { value: 'no_charge_found', label: 'No charge found', hint: 'The supporter was never charged.' },
  ];

  type Row = PageData['items'][number];
  const keyOf = (row: Row) => `${row.bountyId}:${row.userId}`;
  // Without a winner there is nobody to have paid; the main app refuses it too.
  const rulingsFor = (row: Row) =>
    row.winnerUserId == null ? RULINGS.filter((r) => r.value !== 'paid_winner') : RULINGS;
  const rulingLabel = (value: string | null) =>
    RULINGS.find((r) => r.value === value)?.label ?? value ?? '';

  const done = new SvelteMap<string, true>();
  // Held here, not in the form: the row dims on submit and comes back on a refusal.
  const rulings = new SvelteMap<string, BountyAwardRuling>();
  const references = new SvelteMap<string, string>();
  // A row stays marked until the list stops showing it: a lagging read can still return it.
  $effect(() => {
    const open = new Set(data.items.map(keyOf));
    untrack(() => {
      for (const map of [done, rulings, references])
        for (const key of map.keys()) if (!open.has(key)) map.delete(key);
    });
  });

  const refusal = $derived.by(() => {
    if (!form || !('error' in form) || !form.error) return null;
    if (!('bountyId' in form) || !form.bountyId) return form.error;
    const supporter = 'userId' in form ? `, supporter #${form.userId}` : '';
    return `Bounty #${form.bountyId}${supporter}: ${form.error}`;
  });

  const submit = (key: string) =>
    optimisticEnhancer(
      () => {
        done.set(key, true);
        return () => done.delete(key);
      },
      { reload: true }
    );
</script>

<header class="page-header">
  <h1>Unpaid Bounty Awards</h1>
</header>

<p class="mb-4 text-sm text-dark-2">
  Awards and supporter refunds the site could not confirm, held for a moderator to check against
  the Buzz ledger. Recording a ruling closes the record. It moves no Buzz: pay or refund on the
  ledger first, then record what you did.
</p>

<LinkTabs
  class="mb-4"
  active={data.tab}
  items={[
    { value: 'open', label: 'Open', href: '?' },
    {
      value: 'resolved',
      label: `Resolved, last ${data.RESOLVED_WINDOW_DAYS} days`,
      href: '?tab=resolved',
    },
  ]}
/>

{#if !data.migrated}
  <ErrorAlert
    class="mb-4"
    message="Unpaid awards are not recorded on this environment yet: its database is missing the table they live in."
  />
{/if}

{#if refusal}
  <ErrorAlert class="mb-4" message={refusal} />
{/if}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">
    Showing the {data.tab === 'open' ? 'oldest' : 'latest'} {data.limit}.
  </p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">
    {data.tab === 'open' ? 'No open records.' : 'Nothing resolved in this window.'}
  </p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (keyOf(row))}
      {@const key = keyOf(row)}
      {@const isDone = done.has(key)}
      <li
        class={cn(
          'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
          isDone && 'opacity-50'
        )}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          {#if row.bountyName}
            <a
              href={bountyUrl(data.civitaiUrl, row.bountyId)}
              target="_blank"
              rel="noreferrer"
              class="font-medium {LINK_CLASS}"
            >
              {row.bountyName}
            </a>
          {:else}
            <span class="font-medium text-dark-0">Deleted bounty</span>
          {/if}
          <code class="text-xs text-dark-2">#{row.bountyId}</code>
          <Badge variant="secondary">
            {row.winnerUserId == null ? 'refund not confirmed' : 'unpaid award'}
          </Badge>
          {#if row.legacy}
            <Badge variant="outline">activity log only</Badge>
          {/if}
        </div>

        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt class="text-dark-2">Supporter</dt>
          <dd>
            <a href={userLookupUrl(row.userId)} class={LINK_CLASS}>{row.supporter ?? row.userId}</a>
            · {num(row.unitAmount)} Buzz
          </dd>
          {#if row.winnerUserId != null}
            <dt class="text-dark-2">Winner</dt>
            <dd>
              <a href={userLookupUrl(row.winnerUserId)} class={LINK_CLASS}>
                {row.winner ?? row.winnerUserId}
              </a>
            </dd>
          {/if}
          {#if row.ownerId != null}
            <dt class="text-dark-2">Owner</dt>
            <dd>
              <a href={userLookupUrl(row.ownerId)} class={LINK_CLASS}>{row.owner ?? row.ownerId}</a>
            </dd>
          {/if}
          <dt class="text-dark-2">Charges</dt>
          <dd class="font-mono break-all">
            {row.buzzTransactionIds.length ? row.buzzTransactionIds.join(', ') : 'none recorded'}
          </dd>
          <dt class="text-dark-2">Recorded</dt>
          <dd>{dateTime(row.recordedAt)}{#if row.recordedBy}&nbsp;by {row.recordedBy}{/if}</dd>
          {#if row.resolvedAt}
            <dt class="text-dark-2">Ruling</dt>
            <dd>{rulingLabel(row.ruling)}</dd>
            <dt class="text-dark-2">Ledger</dt>
            <dd class="break-all">{row.ledgerReference}</dd>
            <dt class="text-dark-2">Resolved</dt>
            <dd>{dateTime(row.resolvedAt)}{#if row.resolvedBy}&nbsp;by {row.resolvedBy}{/if}</dd>
          {/if}
        </dl>

        {#if row.resolvedAt}
          <!-- Read-only: a recorded ruling is never changed from here. -->
        {:else if isDone}
          <p class="mt-3 text-sm text-dark-2">Ruling recorded</p>
        {:else}
          {@const choices = rulingsFor(row)}
          <form
            method="POST"
            action="?/resolve"
            use:enhance={submit(key)}
            class="mt-3 flex flex-col gap-2"
          >
            <input type="hidden" name="bountyId" value={row.bountyId} />
            <input type="hidden" name="userId" value={row.userId} />
            <RadioGroup
              name="ruling"
              class="gap-1"
              bind:value={() => rulings.get(key) ?? '',
                (v: string) => rulings.set(key, v as BountyAwardRuling)}
            >
              {#each choices as opt (opt.value)}
                <div class="flex items-start gap-2">
                  <RadioGroupItem value={opt.value} id="ruling-{key}-{opt.value}" class="mt-0.5" />
                  <Label for="ruling-{key}-{opt.value}" class="flex flex-col font-normal text-dark-2">
                    <span class="text-dark-0">{opt.label}</span>
                    <span class="text-xs">{opt.hint}</span>
                  </Label>
                </div>
              {/each}
            </RadioGroup>
            <Input
              name="ledgerReference"
              required
              maxlength={500}
              placeholder="Ledger transaction id or note"
              bind:value={() => references.get(key) ?? '', (v: string) => references.set(key, v)}
            />
            <div>
              <Button
                type="submit"
                size="sm"
                disabled={!rulings.get(key) || !(references.get(key) ?? '').trim()}
              >
                Record ruling
              </Button>
            </div>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
