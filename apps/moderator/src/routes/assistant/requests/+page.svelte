<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { TOOL_REQUEST_STATUSES } from '$lib/assistant/types';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Pre-filled from the row, so a successful save must not reset the fields to empty.
  const resolve = new FormState({ onSuccess: null, reload: true, reset: false });
</script>

<h2 class="m-0 mb-1 text-base font-semibold text-white">Tool requests</h2>
<p class="mb-4 text-sm text-dark-2">
  When a question needs a lookup the assistant does not have, it files a request here. The team that
  maintains the assistant reads them and answers below.
</p>

{#if data.storeError}
  <ErrorAlert message={data.storeError} />
{:else if data.requests.length}
  {#if resolve.error}<ErrorAlert message={resolve.error} />{/if}
  <ul class="space-y-3">
    {#each data.requests as r (r.id)}
      <li class="rounded-xl border border-dark-4 bg-dark-6 p-4 text-sm">
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant={r.status === 'open' ? 'outline' : 'secondary'}>{r.status}</Badge>
          <span class="text-xs text-dark-2">#{r.id} · {dateTime(r.createdAt)}{r.mine ? ' · from your chat' : ''}{r.resolvedAt ? ` · resolved ${dateTime(r.resolvedAt)}` : ''}</span>
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
        {#if data.canResolve}
          <details class="mt-2 text-xs text-dark-2">
            <summary>Answer</summary>
            <form method="POST" action="?/resolve" use:enhance={resolve.enhance} class="mt-2 space-y-2">
              <input type="hidden" name="id" value={r.id} />
              <select name="status" class="rounded bg-dark-5 px-1 py-0.5 text-dark-0" value={r.status}>
                {#each TOOL_REQUEST_STATUSES as s (s)}<option value={s}>{s}</option>{/each}
              </select>
              <Textarea name="response" rows={3} maxlength={4000} value={r.response ?? ''} />
              <Button type="submit" size="sm" disabled={resolve.submitting}>Save</Button>
            </form>
          </details>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <p class="text-sm text-dark-2">None yet.</p>
{/if}
