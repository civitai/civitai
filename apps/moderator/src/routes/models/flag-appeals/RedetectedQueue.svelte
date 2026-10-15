<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { SvelteMap } from 'svelte/reactivity';
  import { cn } from '@civitai/ui/utils.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import { failureMessage, formActionHref } from '$lib/minor-flags/appeal-triage';
  import { clearViaLabel } from '$lib/minor-flags/text-scan-verdicts';
  import type { RedetectedRow } from '$lib/server/minor-hash.service';
  import type { RedetectedQueueData } from '$lib/server/minor-flag-queue';
  import { urlWith } from '$lib/url';

  type QueueForm = { error?: string; modelId?: number } | null;

  let {
    data,
    form,
  }: { data: RedetectedQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  // Mirrors the main app's refusal in resolveTextScanRedetection: any Pending appeal on the model, for
  // either label, blocks a ruling. Change both together.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const rowKey = (row: RedetectedRow) => `${row.modelId}:${row.label}`;
  const labelName = (label: RedetectedRow['label']) => (label === 'poi' ? 'Real person' : 'Minor');
  const ago = (value: string) => `${shortAge(value)} ago`;

  // Decided rows dim in place; the list is only re-cut on request, since offsets shift under paging.
  const acted = new SvelteMap<string, string>();
  const errors = new SvelteMap<string, string>();
  $effect(() => {
    void data.items;
    acted.clear();
    errors.clear();
  });

  const submit = (key: string, outcome: string): SubmitFunction => {
    const decide = optimisticEnhancer(() => {
      errors.delete(key);
      acted.set(key, outcome);
      return () => acted.delete(key);
    });
    return async (input) => {
      const finish = await decide(input);
      return async (result) => {
        await finish?.(result);
        const message = failureMessage(result.result);
        if (message) errors.set(key, message);
        else {
          const closed = result.result.type === 'success' && result.result.data?.resolved === 'closed';
          acted.set(key, closed ? 'Already flagged' : outcome);
        }
      };
    };
  };

  const actionHref = (action: string) =>
    formActionHref(action, { view: 'redetected', q: data.q || undefined });
  const pageHref = (n: number) => urlWith(page.url, { page: n });
  const appealsHref = (modelId: number) => urlWith(page.url, { view: null, q: modelId, page: null });
  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null }));
</script>

<form method="GET" class="flex w-full max-w-[24rem] items-center gap-2">
  <input type="hidden" name="view" value="redetected" />
  <Input
    name="q"
    value={data.q}
    placeholder="Model ID, user ID or username"
    aria-label="Search re-detections"
    class="h-9 flex-1 text-sm"
  />
  <Button type="submit" size="lg">Search</Button>
  {#if data.q}
    <Button href={clearSearchHref} variant="outline" size="lg">Clear</Button>
  {/if}
</form>

<p class="m-0 max-w-3xl text-sm text-dark-2">
  The scan found these again on text edited after a moderator or an appeal cleared them. Nothing
  was flagged and the owner has not been told. Keep applies the flag; Dismiss clears the new text.
</p>

{#if form?.error && errors.size === 0}
  <ErrorAlert message={form.modelId ? `Model #${form.modelId}: ${form.error}` : form.error} />
{/if}

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if data.items.length}
    <ul class="m-0 flex list-none flex-col gap-3 p-0">
      {#each data.items as row (rowKey(row))}
        {@const key = rowKey(row)}
        {@const outcome = acted.get(key)}
        {@const error = errors.get(key)}
        <li
          class={cn('rounded-xl border border-dark-4 bg-dark-6 p-5', outcome && 'opacity-60')}
          data-redetected={key}
        >
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <a
              href="{data.civitaiUrl}/models/{row.modelId}?view=basic"
              target="_blank"
              rel="noreferrer"
              class="text-lg font-semibold {LINK_CLASS}"
            >
              {row.modelName} ↗
            </a>
            <code class="text-sm text-dark-2">#{row.modelId}</code>
            <Badge variant="secondary" class="h-6 px-2.5 text-sm">{row.status}</Badge>
            <Badge class="h-6 px-2.5 text-sm">{labelName(row.label)}</Badge>
            <span class="text-sm text-dark-2">
              by
              {#if row.username}
                <a href={userLookupUrl(row.userId)} class={LINK_CLASS}>{row.username}</a>
              {:else}
                user #{row.userId}
              {/if}
            </span>
          </div>

          <div class="mt-3 grid gap-3 lg:grid-cols-2">
            <section class="rounded-md bg-dark-7 p-3 text-sm text-dark-0">
              <p class="m-0 font-medium text-white">Previously cleared</p>
              {#if row.granted}
                <p class="m-0 mt-1">
                  {clearViaLabel(row.granted.via)}
                  {#if row.grantedByUsername}
                    by <span class="font-medium text-white">{row.grantedByUsername}</span>
                  {:else if row.granted.by}
                    by user #{row.granted.by}
                  {/if}
                  {#if row.granted.at}
                    <span title={dateTime(row.granted.at)}>{ago(row.granted.at)}</span>
                  {/if}
                </p>
              {:else}
                <p class="m-0 mt-1">No clearing record.</p>
              {/if}
            </section>
            <section class="rounded-md bg-dark-7 p-3 text-sm text-dark-0">
              <p class="m-0 font-medium text-white">
                Detected again
                {#if row.redetected.at}
                  <span class="font-normal" title={dateTime(row.redetected.at)}>
                    {ago(row.redetected.at)}
                  </span>
                {/if}
              </p>
              <p class="m-0 mt-1">{row.redetected.reason ?? 'No reason recorded.'}</p>
              {#if row.redetected.names?.length}
                <p class="m-0 mt-1 text-dark-2">Names: {row.redetected.names.join(', ')}</p>
              {/if}
            </section>
          </div>

          {#if row.hasPendingAppeal}
            <p class="m-0 mt-3 text-sm text-dark-0">
              The owner has an open appeal; resolve it first.
              <a href={appealsHref(row.modelId)} class={LINK_CLASS}>Open it</a>
            </p>
          {/if}

          {#if error}
            <ErrorAlert class="mt-3" message={error} />
          {/if}
          <div class="mt-4 flex flex-wrap items-center gap-3">
            {#if outcome}
              <span role="status" class="text-base font-medium text-white">{outcome}</span>
            {:else}
              <form
                method="POST"
                action={actionHref('keepRedetected')}
                use:enhance={submit(key, 'Flag kept')}
              >
                <input type="hidden" name="modelId" value={row.modelId} />
                <input type="hidden" name="label" value={row.label} />
                <input type="hidden" name="textHash" value={row.redetected.textHash} />
                <Button
                  type="submit"
                  size="lg"
                  class="h-11 px-5 text-base"
                  disabled={row.hasPendingAppeal}
                  title={row.hasPendingAppeal ? APPEAL_FIRST : undefined}
                >
                  Keep flagged
                </Button>
              </form>
              <form
                method="POST"
                action={actionHref('dismissRedetected')}
                use:enhance={submit(key, 'Dismissed')}
              >
                <input type="hidden" name="modelId" value={row.modelId} />
                <input type="hidden" name="label" value={row.label} />
                <input type="hidden" name="textHash" value={row.redetected.textHash} />
                <Button
                  type="submit"
                  size="lg"
                  variant="destructive"
                  class="h-11 px-5 text-base"
                  disabled={row.hasPendingAppeal}
                  title={row.hasPendingAppeal ? APPEAL_FIRST : undefined}
                >
                  Dismiss
                </Button>
              </form>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="p-5 text-sm text-dark-0">
      <p class="m-0">
        {data.q ? `Nothing matches "${data.q}".` : 'No labels are waiting on a re-detection.'}
      </p>
      {#if data.q}
        <a href={clearSearchHref} class="mt-2 inline-block {LINK_CLASS}">Clear search</a>
      {/if}
    </div>
  {/if}
</div>

{#if data.items.length}
  <footer class="flex shrink-0 flex-wrap items-center gap-3 text-sm text-dark-0">
    {#if acted.size}
      <Button size="sm" variant="outline" onclick={() => invalidateAll()}>
        Refresh queue ({acted.size} decided)
      </Button>
    {:else}
      {#if data.page > 1}<a href={pageHref(data.page - 1)} class={LINK_CLASS}>← Previous</a>{/if}
      {#if data.hasMore}<a href={pageHref(data.page + 1)} class={LINK_CLASS}>Next →</a>{/if}
    {/if}
  </footer>
{/if}
