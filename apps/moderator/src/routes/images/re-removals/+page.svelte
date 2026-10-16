<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { imageLookupUrl, userLookupUrl } from '$lib/entity-url';
  import { VIOLATION_LABELS } from '$lib/violations';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const TABS = (['Pending', 'Confirmed', 'Declined', 'Void'] as const).map((value) => ({
    value,
    label: value,
    href: value === 'Pending' ? '?' : `?status=${value}`,
  }));

  const failure = $derived(form as { error?: string; id?: number } | null);
  const rowError = $derived(
    failure?.error && failure.id ? { id: failure.id, error: failure.error } : null
  );
  const canDecide = $derived(!!data.grants['image.removal.confirm']);

  const acted = new SvelteMap<number, string>();
  const notes = new SvelteMap<number, string>();
  $effect(() => {
    data.items;
    acted.clear();
  });

  const submit = (id: number, verdict: string) =>
    optimisticEnhancer(
      () => {
        acted.set(id, verdict);
        return () => acted.delete(id);
      },
      { reload: true }
    );

  const reasonLabel = (v: string | null) =>
    v ? VIOLATION_LABELS[v as keyof typeof VIOLATION_LABELS] ?? v : 'No reason given';
</script>

<header class="page-header">
  <h1>Re-removals</h1>
</header>

<p class="mb-4 text-sm text-dark-2">
  A moderator tried to remove these images for the same reason an approved appeal overturned. The
  images stay up until someone confirms the removal here; the moderator who asked cannot confirm their
  own.
</p>

<LinkTabs class="mb-4" items={TABS} active={data.status} />

{#if form && 'status' in form && form.status === 'Void'}
  <p class="mb-4 text-sm text-dark-2" role="status">
    Request #{form.id} was voided, not run: {(form as { note?: string }).note}.
  </p>
{/if}

{#if form?.error && !rowError}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

{#if !canDecide && data.status === 'Pending'}
  <p class="mb-3 text-sm text-dark-2">
    Read-only: confirming or declining needs the "Confirm re-removals" permission, granted on
    `/admin`.
  </p>
{/if}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">Showing {data.limit}.</p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">Nothing {data.status.toLowerCase()}.</p>
{:else}
  <ul class="space-y-3">
    {#each data.items as row (row.id)}
      {@const verdict = acted.get(row.id)}
      <li
        class={cn(
          'flex flex-col gap-4 rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity sm:flex-row',
          verdict && 'opacity-50'
        )}
      >
        <a href={imageLookupUrl(row.imageId)} class="w-full shrink-0 sm:w-48">
          <EdgeMedia
            src={row.url}
            type={row.mediaType === 'video' ? 'video' : 'image'}
            width={400}
            class="w-full rounded-md object-cover"
          />
        </a>

        <div class="min-w-0 flex-1 space-y-2 text-sm">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <a href={imageLookupUrl(row.imageId)} class="font-medium {LINK_CLASS}">
              Image #{row.imageId}
            </a>
            {#if row.ownerUsername}
              <a href={userLookupUrl(row.ownerId)} class="text-xs {LINK_CLASS}">
                {row.ownerUsername}
              </a>
            {/if}
            {#if row.ingestion === 'Blocked'}
              <Badge variant="secondary">removed</Badge>
            {/if}
          </div>

          <div class="rounded-md bg-dark-7 p-2">
            <p class="text-xs font-semibold text-dark-2">Removal requested</p>
            <p>
              {reasonLabel(row.violationType)} · by
              {#if row.requestedById}
                <a href={userLookupUrl(row.requestedById)} class={LINK_CLASS}>
                  {row.requestedByUsername ?? `user ${row.requestedById}`}
                </a>
              {:else}
                an unnamed caller
              {/if}
              · {dateTime(row.requestedAt)}
            </p>
            {#if row.violationDetails}
              <p class="mt-1 text-dark-0">{row.violationDetails}</p>
            {/if}
            {#if row.reportIds.length}
              <p class="mt-1 text-xs text-dark-2">
                Confirming also actions report{row.reportIds.length === 1 ? '' : 's'}
                {row.reportIds.map((id) => `#${id}`).join(', ')}.
              </p>
            {/if}
          </div>

          <div class="rounded-md bg-dark-7 p-2">
            <p class="text-xs font-semibold text-dark-2">Appeal approved</p>
            <p>
              {dateTime(row.approvedAt)}
              {#if row.approvedByUsername}· by {row.approvedByUsername}{/if}
              {#if row.removalLabel}· overturned {reasonLabel(row.removalLabel)}{/if}
              {#if row.resolvedReason}· {row.resolvedReason}{/if}
            </p>
            {#if row.resolvedMessage}
              <p class="mt-1 text-dark-0">Told the user: {row.resolvedMessage}</p>
            {/if}
            <p class="mt-1 text-xs text-dark-2">Appeal: {row.appealMessage}</p>
          </div>

          {#if row.status !== 'Pending'}
            <p class="text-xs text-dark-2">
              {row.status}
              {#if row.decidedByUsername}by {row.decidedByUsername}{/if}
              · {dateTime(row.decidedAt)}
              {#if row.decisionNote}· {row.decisionNote}{/if}
            </p>
          {:else if verdict}
            <span class="text-dark-2">{verdict}</span>
          {:else if canDecide}
            {#if rowError?.id === row.id}
              <ErrorAlert message={rowError.error} />
            {/if}
            <Textarea
              placeholder="Note (optional)"
              value={notes.get(row.id) ?? ''}
              oninput={(e) => notes.set(row.id, e.currentTarget.value)}
              rows={2}
              maxlength={1000}
              class="resize-none text-xs"
            />
            <div class="flex flex-wrap gap-2">
              <form method="POST" action="?/confirm" use:enhance={submit(row.id, 'Removal confirmed')}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="note" value={notes.get(row.id) ?? ''} />
                <Button
                  type="submit"
                  size="xs"
                  variant="destructive"
                  disabled={row.requestedById === data.user?.id}
                  title={row.requestedById === data.user?.id
                    ? 'You requested this removal; another moderator must confirm it.'
                    : undefined}
                >
                  Confirm removal
                </Button>
              </form>
              <form method="POST" action="?/decline" use:enhance={submit(row.id, 'Declined')}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="note" value={notes.get(row.id) ?? ''} />
                <Button type="submit" size="xs" variant="outline">Decline: keep it up</Button>
              </form>
            </div>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
