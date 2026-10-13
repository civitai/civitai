<script lang="ts">
  import { enhance } from '$app/forms';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import RulingForm, { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { appealRulingChoices } from '$lib/ruling-choices';
  import type { ActionData, PageData } from './$types';

  type Verdict = ResolutionVerdict<'appeal'>;

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const CHOICES = appealRulingChoices();
  // Cast: the generated ActionData drops the `appealId` the refusals carry (svelte-check, 2026-10-13).
  const failure = $derived(form as { error?: string; appealId?: number } | null);
  const rowError = $derived(
    failure?.error && failure.appealId ? { appealId: failure.appealId, error: failure.error } : null
  );
  // Kept past the next verdict, whose result replaces `form`: the row is gone after the reload.
  const refundUnconfirmed = new SvelteSet<number>();
  $effect(() => {
    if (form?.refundFailed && form.appealId) refundUnconfirmed.add(form.appealId);
  });
  const acted = new SvelteMap<number, string>();
  const messages = new SvelteMap<number, string>();
  const drafts = new SvelteMap<number, RulingDraft<Verdict>>();
  $effect(() => {
    data.items;
    acted.clear();
  });

  // A refused verdict must undo its mark, or a moderator believes they ruled on an appeal that
  // is still open.
  const submit = (appealId: number, verdict: string | (() => string)) =>
    optimisticEnhancer(
      () => {
        acted.set(appealId, typeof verdict === 'function' ? verdict() : verdict);
        return () => acted.delete(appealId);
      },
      { reload: true }
    );
</script>

<header class="page-header">
  <h1>Appeals: Content Removed</h1>
</header>

<p class="mb-4 text-sm text-dark-2">
  The appealed image or model was deleted before anyone reviewed the appeal. It cannot be restored:
  the verdict decides the refund and what the user is told.
</p>

{#if form?.error && !rowError}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

<!-- A timed-out refund can still land, so this asks for a check, not a second refund. -->
{#each [...refundUnconfirmed] as appealId (appealId)}
  <ErrorAlert
    class="mb-4"
    message={`Appeal #${appealId} is closed, but its fee may not have been refunded. Check its Buzz transaction before refunding by hand.`}
  />
{/each}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">Showing the {data.limit} that have waited longest.</p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">No open appeals on removed content.</p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (row.id)}
      {@const verdict = acted.get(row.id)}
      <li
        class={cn(
          'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
          verdict && 'opacity-50'
        )}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="font-medium">{row.entityType} #{row.entityId}</span>
          <code class="text-xs text-dark-2">appeal #{row.id}</code>
          {#if row.hasFee}
            <Badge variant="secondary">fee paid</Badge>
          {/if}
          {#if row.username}
            <a href={userLookupUrl(row.userId)} class="text-xs {LINK_CLASS}">{row.username}</a>
          {/if}
          <span class="text-xs text-dark-2">
            appealed {dateTime(row.createdAt)}
            {#if row.entityRemovedAt}· removed by {dateTime(row.entityRemovedAt)}{/if}
          </span>
        </div>

        <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0">{row.appealMessage}</p>

        {#if row.history.length}
          <ul class="mt-2 space-y-0.5 text-xs text-dark-2">
            {#each row.history as h, i (i)}
              <li>
                {h.activity} · {dateTime(h.at)}
                {#if h.moderatorId}
                  · <a href={userLookupUrl(h.moderatorId)} class={LINK_CLASS}>moderator</a>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2 text-xs text-dark-2">No moderation record for this {row.entityType}.</p>
        {/if}

        {#if rowError?.appealId === row.id}
          <ErrorAlert class="mt-2" message={rowError.error} />
        {/if}

        <div class="mt-3 flex flex-col gap-1.5">
          {#if verdict}
            <span class="text-sm text-dark-2">{verdict}</span>
          {:else}
            <Textarea
              placeholder="Message to the user (optional)"
              value={messages.get(row.id) ?? ''}
              oninput={(e) => messages.set(row.id, e.currentTarget.value)}
              rows={2}
              maxlength={1000}
              class="resize-none text-xs"
            />
            <RulingForm
              subject="appeal"
              choices={CHOICES}
              action="?/resolve"
              enhancer={submit(row.id, () =>
                drafts.get(row.id)?.verdict === 'Approved' ? 'Appeal approved' : 'Appeal rejected'
              )}
              idPrefix="removed-appeal-{row.id}"
              size="xs"
              bind:draft={() => drafts.get(row.id) ?? emptyRulingDraft<Verdict>(),
                (d: RulingDraft<Verdict>) => drafts.set(row.id, d)}
            >
              {#snippet hidden()}
                <input type="hidden" name="appealId" value={row.id} />
                <input type="hidden" name="resolvedMessage" value={messages.get(row.id) ?? ''} />
              {/snippet}
            </RulingForm>
            <form
              method="POST"
              action="?/ownerDeleted"
              use:enhance={submit(row.id, 'Closed: deleted by owner')}
            >
              <input type="hidden" name="appealId" value={row.id} />
              <Button type="submit" size="xs" variant="outline">
                Close: the user deleted it
              </Button>
            </form>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
