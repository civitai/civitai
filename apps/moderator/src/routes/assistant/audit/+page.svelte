<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const filterHref = (moderator: number | null, before: number | null = null) => {
    const params = new URLSearchParams();
    if (moderator) params.set('moderator', String(moderator));
    if (before) params.set('before', String(before));
    return `/assistant/audit${params.size ? `?${params}` : ''}`;
  };
</script>

<h2 class="m-0 mb-1 text-base font-semibold text-white">Assistant audit</h2>
<p class="mb-4 text-sm text-dark-2">
  Every question asked of the assistant, by every moderator: the lookups it ran, what they returned and
  what it answered.
  {#if data.moderator}
    Showing one moderator. <a href={filterHref(null)} class={LINK_CLASS}>Show everyone</a>
  {/if}
</p>

{#if data.storeError}
  <ErrorAlert message={data.storeError} />
{:else if data.turns.length}
  <ul class="space-y-3">
    {#each data.turns as t (t.id)}
      <li class="rounded-xl border border-dark-4 bg-dark-6 p-4 text-sm">
        <div class="mb-1 flex flex-wrap items-center gap-2 text-xs text-dark-2">
          <span>#{t.id} · {dateTime(t.createdAt)}</span>
          <a href={filterHref(t.moderatorId)} class={LINK_CLASS}>{t.moderatorName ?? `#${t.moderatorId}`}</a>
          <span>· {t.chatTitle}</span>
          <Badge variant={t.status === 'error' ? 'destructive' : t.status === 'done' ? 'secondary' : 'outline'}>
            {t.status}
          </Badge>
          {#if t.playbookSlug}<Badge variant="outline">{t.playbookSlug} v{t.playbookVersion}</Badge>{/if}
          <span>{num(t.totalTokens)} tokens · {t.model}</span>
        </div>
        <p class="m-0 break-words whitespace-pre-wrap text-dark-0">{t.prompt}</p>
        {#if t.answer}
          <p class="mt-2 mb-0 border-l-2 border-dark-4 pl-3 break-words whitespace-pre-wrap text-dark-1">{t.answer}</p>
        {:else if t.error}
          <p class="mt-2 mb-0 text-red-300">{t.error}</p>
        {/if}
        {#if t.reasoning}
          <details class="mt-2 text-xs text-dark-2">
            <summary>Reasoning</summary>
            <p class="mt-2 mb-0 break-words whitespace-pre-wrap">{t.reasoning}</p>
          </details>
        {/if}
        <details class="mt-2 text-xs text-dark-2">
          <summary>
            {t.toolCalls.length} lookups{t.unverified.length ? ` · ${t.unverified.length} unverified citations` : ''}
          </summary>
          <ol class="mt-2 space-y-1">
            {#each t.toolCalls as call, i (i)}
              <li>
                <code class="text-dark-0">{call.name}</code>
                <code class="break-all">{JSON.stringify(call.args)}</code>
                → {call.error ? `error: ${call.error}` : `${num(call.rows)} rows${call.truncated ? ' (truncated)' : ''}`}
                · {num(call.ms)} ms
              </li>
            {/each}
          </ol>
        </details>
      </li>
    {/each}
  </ul>
  {#if data.nextBefore}
    <Button href={filterHref(data.moderator, data.nextBefore)} variant="outline" size="sm" class="mt-4">
      Older
    </Button>
  {/if}
{:else}
  <p class="text-sm text-dark-2">No questions yet.</p>
{/if}
