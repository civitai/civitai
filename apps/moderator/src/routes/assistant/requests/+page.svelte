<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<h2 class="m-0 mb-1 text-base font-semibold text-white">Tool requests</h2>
<p class="mb-4 text-sm text-dark-2">
  When a question needs a lookup the assistant does not have, it files a request here. The team that
  maintains the assistant reads them and answers below.
</p>

{#if data.storeError}
  <ErrorAlert message={data.storeError} />
{:else if data.requests.length}
  <ul class="space-y-3">
    {#each data.requests as r (r.id)}
      <li class="rounded-xl border border-dark-4 bg-dark-6 p-4 text-sm">
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant={r.status === 'open' ? 'outline' : 'secondary'}>{r.status}</Badge>
          <span class="text-xs text-dark-2">#{r.id} · {dateTime(r.createdAt)}{r.mine ? ' · from your chat' : ''}</span>
        </div>
        <p class="m-0 text-dark-0">{r.need}</p>
        <p class="mt-1 mb-0 text-xs text-dark-2">Why: {r.reason}</p>
        {#if r.example}<p class="mt-1 mb-0 text-xs text-dark-2">Example: {r.example}</p>{/if}
        {#if r.response}
          <p class="mt-2 mb-0 rounded bg-dark-7 p-2 text-xs text-dark-0">{r.response}</p>
        {/if}
        {#if r.conversation?.length}
          <details class="mt-2 text-xs text-dark-2">
            <summary>The conversation ({r.conversation.length})</summary>
            <ol class="mt-2 space-y-2">
              {#each r.conversation as c, i (i)}
                <li>
                  <p class="m-0 text-dark-0">{c.prompt}</p>
                  {#if c.answer}<p class="m-0 break-words whitespace-pre-wrap">{c.answer}</p>{/if}
                </li>
              {/each}
            </ol>
          </details>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <p class="text-sm text-dark-2">None yet.</p>
{/if}
