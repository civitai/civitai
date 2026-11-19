<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { allowedActions, type PayoutReviewAction } from '$lib/payout-review';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const ACTION_LABEL: Record<PayoutReviewAction, string> = {
    clear: 'Clear (pay)',
    escalate: 'Escalate',
    withhold: 'Withhold this cycle',
  };
  const usd = (cents: number) =>
    (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const canDecide = $derived(!!data.grants['creatorProgram.payoutReview.decide']);

  const done = new SvelteMap<number, true>();
  // Held above the form so a refused submit keeps what was typed.
  const notes = new SvelteMap<number, string>();
  const askRefs = new SvelteMap<number, string>();
  $effect(() => {
    const shown = new Set(data.items.map((row) => row.id));
    untrack(() => {
      for (const map of [done, notes, askRefs])
        for (const id of map.keys()) if (!shown.has(id)) map.delete(id);
    });
  });

  const refusal = $derived.by(() => {
    const refused = form as { error?: string; id?: number; reason?: string | null } | null;
    if (!refused?.error) return null;
    const reason = refused.reason ? ` (${refused.reason})` : '';
    return refused.id ? `Review #${refused.id}: ${refused.error}${reason}` : refused.error;
  });

  const submit = (id: number) =>
    optimisticEnhancer(
      () => {
        done.set(id, true);
        return () => done.delete(id);
      },
      { reload: true }
    );
</script>

<header class="page-header">
  <h1>Payout Reviews</h1>
</header>

<p class="mb-4 text-sm text-dark-2">
  Creator Program payouts the pre-payout review is holding. A held creator's pending cash is left
  out of settlement on the 15th until the review is cleared. Withhold means not paid this cycle,
  never forfeited: the creator is reviewed again next cycle. Decisions move no money here; a cleared
  creator is paid at the next settlement.
</p>

<LinkTabs
  class="mb-4"
  active={data.view}
  items={[
    { value: 'holding', label: 'Open, escalated and withheld', href: '?' },
    { value: 'cleared', label: 'Cleared, not yet settled', href: '?view=cleared' },
  ]}
/>

{#if data.view === 'cleared'}
  <p class="mb-4 text-xs text-dark-2">
    Reviews cleared after the last settlement ({dateTime(data.lastSettlementAt)}): the next one
    pays them, so a mistaken clear can still be escalated or withheld here. This assumes settlement
    ran on time; if it failed or ran late, a review cleared just before it may be listed as settled
    when it was not.
  </p>
{/if}

{#if refusal}
  <ErrorAlert class="mb-4" message={refusal} />
{/if}

{#if !canDecide}
  <p class="mb-4 text-xs text-dark-2">
    You can read these reviews. Deciding them needs the "Decide Creator Program payout-review holds"
    permission.
  </p>
{/if}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">Showing the first {data.items.length}.</p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">
    {data.view === 'holding' ? 'No payouts are held.' : 'Nothing cleared since the last settlement.'}
  </p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (row.id)}
      {@const isDone = done.has(row.id)}
      {@const choices = allowedActions(row.status)}
      <li
        class={cn(
          'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
          isDone && 'opacity-50'
        )}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <a href={userLookupUrl(row.userId)} class="font-medium {LINK_CLASS}">
            {row.username ?? row.userId}
          </a>
          <code class="text-xs text-dark-2">#{row.id}</code>
          <span class="text-sm text-dark-2">{row.period}</span>
          <Badge variant={row.status === 'withheld' ? 'destructive' : 'secondary'}>{row.status}</Badge>
          <span class="text-xs text-dark-2">version {row.version}</span>
        </div>

        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt class="text-dark-2">Payout</dt>
          <dd>{usd(row.payoutCents)}</dd>
          <dt class="text-dark-2">Signals</dt>
          <dd>{row.signals.length ? row.signals.join(', ') : 'none'}</dd>
          {#each row.evidence.signals as signal (signal.name)}
            <dt class="pl-2 text-dark-2">{signal.name}</dt>
            <dd>
              {num(signal.value)} against a limit of {num(signal.limit)}
              {#if signal.counterpartyId != null}
                · with <a href={userLookupUrl(signal.counterpartyId)} class={LINK_CLASS}
                  >user {signal.counterpartyId}</a
                >
              {/if}
            </dd>
          {/each}
          {#if row.evidence.bankable != null}
            <dt class="text-dark-2">Bankable Buzz</dt>
            <dd>{num(row.evidence.bankable)}</dd>
          {/if}
          <dt class="text-dark-2">Prior payouts</dt>
          <dd>
            {row.evidence.priorPayoutsCents.length
              ? row.evidence.priorPayoutsCents.map(usd).join(', ')
              : 'none'}
          </dd>
          <dt class="text-dark-2">Two-way exchanges</dt>
          <dd>{num(row.evidence.exchangeCount)}</dd>
          {#if row.evidence.manual}
            <dt class="text-dark-2">Manual hold</dt>
            <dd>{row.evidence.manual.ground}: {row.evidence.manual.reason}</dd>
          {/if}
          <dt class="text-dark-2">Flagged</dt>
          <dd>{dateTime(row.firstFlaggedAt)}</dd>
          {#if row.decidedAt}
            <dt class="text-dark-2">Last decided</dt>
            <dd>{dateTime(row.decidedAt)}{#if row.decidedBy}&nbsp;by {row.decidedBy}{/if}</dd>
          {/if}
          {#if row.askRef}
            <dt class="text-dark-2">Ask</dt>
            <dd class="break-all">{row.askRef}</dd>
          {/if}
        </dl>

        {#if row.decisions.length}
          <details class="mt-2 text-xs">
            <summary class="cursor-pointer text-dark-2">
              History ({row.decisions.length})
            </summary>
            <ol class="mt-1 space-y-1">
              {#each row.decisions as entry, i (i)}
                <li>
                  {dateTime(entry.at)} · {entry.by} · {entry.action}
                  ({entry.from} → {entry.to}){#if entry.ground}&nbsp;· {entry.ground}{/if}
                  {#if entry.note}<div class="text-dark-2">{entry.note}</div>{/if}
                  {#if entry.askRef}<div class="text-dark-2 break-all">Ask: {entry.askRef}</div>{/if}
                </li>
              {/each}
            </ol>
          </details>
        {/if}

        {#if isDone}
          <p class="mt-3 text-sm text-dark-2">Decision recorded</p>
        {:else if canDecide && choices.length}
          <form
            method="POST"
            action="?/decide"
            use:enhance={submit(row.id)}
            class="mt-3 flex flex-col gap-2"
          >
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="userId" value={row.userId} />
            <input type="hidden" name="period" value={row.period} />
            <input type="hidden" name="version" value={row.version} />
            <Textarea
              name="note"
              required
              maxlength={2000}
              rows={2}
              placeholder="Why (required, kept in the review's history)"
              bind:value={() => notes.get(row.id) ?? '', (v: string) => notes.set(row.id, v)}
            />
            <Input
              name="askRef"
              maxlength={200}
              placeholder="Ticket or ask reference (optional)"
              bind:value={() => askRefs.get(row.id) ?? '', (v: string) => askRefs.set(row.id, v)}
            />
            <div class="flex flex-wrap gap-2">
              {#each choices as action (action)}
                <Button
                  type="submit"
                  name="action"
                  value={action}
                  size="sm"
                  variant={action === 'clear' ? 'default' : 'outline'}
                  disabled={!(notes.get(row.id) ?? '').trim()}
                >
                  {ACTION_LABEL[action]}
                </Button>
              {/each}
            </div>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
