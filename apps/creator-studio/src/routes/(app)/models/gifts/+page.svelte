<script lang="ts">
  import { enhance } from '$app/forms';
  import { afterNavigate } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import * as Alert from '@civitai/ui/components/ui/alert/index.js';
  import { ConfirmButton } from '@civitai/ui/components/confirm/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { batchStatus, linkStatus } from './gift-links';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let pending = $state(false);
  let failure = $state<string | null>(null);
  // Paging keeps this component, so a failed revoke's message would sit above unrelated rows.
  afterNavigate(() => (failure = null));

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : 'Never');

  const submit: SubmitFunction = () => {
    pending = true;
    failure = null;
    return async ({ result, update }) => {
      pending = false;
      if (result.type === 'failure') failure = String(result.data?.error ?? 'Request failed.');
      await update();
    };
  };
</script>

<svelte:head><title>Gift links</title></svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-5 p-5">
  <div>
    <a href="/models" class="text-sm text-dark-2 hover:text-white">← Models</a>
    <h1 class="mt-1 text-xl font-semibold text-white">Gift links</h1>
    <p class="text-sm text-dark-2">
      Every gift link on your models, newest first. Open a version to create more. Revoking stops
      new claims; people who already claimed keep access.
    </p>
  </div>

  {#if failure}
    <p class="text-sm text-red-4">{failure}</p>
  {/if}

  {#if data.listError}
    <Alert.Root variant="destructive">
      <Alert.Title>Couldn't load your gift links</Alert.Title>
      <Alert.Description>{data.listError}</Alert.Description>
    </Alert.Root>
  {:else if data.page.items.length === 0}
    <p class="text-sm text-dark-2">
      {data.paged ? 'No older gift links.' : 'No gift links yet.'}
    </p>
  {:else}
    <section class="cs-panel p-0">
      <ul class="divide-y divide-dark-4">
        {#each data.page.items as item (item.kind === 'link' ? `l${item.id}` : `b${item.batchId}`)}
          {@const st = item.kind === 'link' ? linkStatus(item) : batchStatus(item)}
          <li class="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span class="flex min-w-0 flex-1 flex-col">
              <a
                href="/models/gifts/{item.modelVersionId}"
                class="truncate text-dark-0 hover:text-white"
              >
                {item.modelName} · {item.versionName}
              </a>
              <span class="text-dark-2">
                {#if item.kind === 'link'}
                  Multi-use link ···{item.codeHint}{item.label ? ` · ${item.label}` : ''}
                {:else}
                  {item.total} single-use links{item.label ? ` · ${item.label}` : ''}
                {/if}
              </span>
            </span>
            <span class="text-dark-2">
              {#if item.kind === 'link'}
                {item.redemptionCount}{item.maxRedemptions ? ` / ${item.maxRedemptions}` : ''} claimed
              {:else}
                {item.claimed} / {item.total} claimed
              {/if}
              · expires {fmt(item.expiresAt)}
            </span>
            <Badge variant="outline">{st}</Badge>
            {#if st === 'Active'}
              <form method="POST" action="?/revoke" use:enhance={submit}>
                <input type="hidden" name="versionId" value={item.modelVersionId} />
                {#if item.kind === 'link'}
                  <input type="hidden" name="id" value={item.id} />
                {:else}
                  <input type="hidden" name="batchId" value={item.batchId} />
                {/if}
                <ConfirmButton
                  label="Revoke"
                  title={item.kind === 'link' ? 'Revoke this link?' : 'Revoke this batch?'}
                  description={item.kind === 'link'
                    ? 'Nobody new can claim it. People who already claimed keep access.'
                    : `Its ${item.live} unclaimed links stop working. This can't be undone.`}
                  disabled={pending}
                />
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if data.paged || data.page.nextCursor}
    <nav class="flex justify-between text-sm">
      {#if data.paged}
        <a href="/models/gifts" class="text-dark-2 hover:text-white">← Newest</a>
      {:else}
        <span></span>
      {/if}
      {#if data.page.nextCursor}
        <a
          href="/models/gifts?cursor={encodeURIComponent(data.page.nextCursor)}"
          class="text-dark-2 hover:text-white">Older →</a
        >
      {/if}
    </nav>
  {/if}
</div>
