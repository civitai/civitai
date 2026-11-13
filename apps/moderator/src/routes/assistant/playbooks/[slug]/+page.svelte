<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import PlaybookFields from '../PlaybookFields.svelte';
  import ToolList from '../ToolList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const canEdit = $derived(!!data.grants['assistant.use']);
  const edit = new FormState({ onSuccess: null, reload: true, reset: false });
  const review = new FormState({ onSuccess: null, reload: true });
  const archive = new FormState({ onSuccess: null, reload: true });
  const proposals = $derived(data.versions.filter((v) => v.status === 'proposed'));
  const statusVariant = (status: string) =>
    status === 'accepted' ? 'secondary' : status === 'proposed' ? 'outline' : 'destructive';
</script>

<a href="/assistant/playbooks" class="text-sm text-dark-2 hover:underline">← Playbooks</a>
<div class="mt-2 mb-4 flex flex-wrap items-center gap-2">
  <h2 class="m-0 text-base font-semibold text-white">{data.current?.title ?? data.slug}</h2>
  <code class="text-xs text-dark-2">{data.slug}{data.current ? ` v${data.current.version}` : ''}</code>
  {#if data.archived}<Badge variant="destructive">archived</Badge>{/if}
</div>

{#if proposals.length}
  <section class="mb-6 space-y-4">
    {#each proposals as p (p.version)}
      <div class="rounded-xl border border-amber-500/40 bg-dark-6 p-4">
        <p class="m-0 mb-2 text-sm text-amber-300">
          Draft v{p.version}, written by the assistant in {p.author}’s chat{p.sourceTurnId
            ? ` (turn ${p.sourceTurnId})`
            : ''}. It changes nothing until accepted.
        </p>
        <h3 class="m-0 text-sm font-semibold text-white">{p.title}</h3>
        <p class="text-sm text-dark-2">{p.summary}</p>
        <pre class="max-h-80 overflow-auto rounded bg-dark-7 p-3 text-xs whitespace-pre-wrap text-dark-0">{p.body}</pre>
        {#if canEdit}
          <form method="POST" action="?/review" use:enhance={review.enhance} class="mt-3 flex gap-2">
            <input type="hidden" name="version" value={p.version} />
            <Button type="submit" size="sm" name="decision" value="accept" disabled={review.submitting}>
              Accept
            </Button>
            <Button type="submit" size="sm" variant="outline" name="decision" value="reject" disabled={review.submitting}>
              Reject
            </Button>
          </form>
        {/if}
      </div>
    {/each}
    {#if review.error}<ErrorAlert message={review.error} />{/if}
  </section>
{/if}

{#if data.current}
  <section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="mt-0 text-sm text-dark-2">{data.current.summary}</p>
    <pre class="m-0 text-sm break-words whitespace-pre-wrap text-dark-0">{data.current.body}</pre>
  </section>
{/if}

{#if canEdit && data.redacted}
  <p class="mb-6 text-sm text-dark-2">
    This playbook quotes addresses you cannot see, so it can be edited only by a moderator with User
    Lookup.
  </p>
{:else if canEdit}
  <details class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-4">
    <summary class="text-sm font-semibold text-white">Edit</summary>
    <form method="POST" action="?/edit" use:enhance={edit.enhance} class="mt-4 space-y-3">
      <PlaybookFields
        title={data.current?.title ?? ''}
        summary={data.current?.summary ?? ''}
        body={data.current?.body ?? ''}
      />
      <ToolList tools={data.tools} />
      {#if edit.error}<ErrorAlert message={edit.error} />{/if}
      <Button type="submit" disabled={edit.submitting}>Save as a new version</Button>
    </form>
  </details>
  <form method="POST" action="?/archive" use:enhance={archive.enhance} class="mb-6">
    <input type="hidden" name="archived" value={data.archived ? '0' : '1'} />
    <Button type="submit" size="sm" variant="ghost" disabled={archive.submitting}>
      {data.archived ? 'Restore playbook' : 'Archive playbook'}
    </Button>
    {#if archive.error}<ErrorAlert message={archive.error} class="mt-2" />{/if}
  </form>
{/if}

<section>
  <h3 class="mb-2 text-sm font-semibold text-white">History</h3>
  <ul class="space-y-1 text-sm">
    {#each data.versions as v (v.version)}
      <li class="flex flex-wrap items-baseline gap-2">
        <code class="text-xs">v{v.version}</code>
        <Badge variant={statusVariant(v.status)}>{v.status}</Badge>
        <span class="text-dark-0">{v.title}</span>
        <span class="text-xs text-dark-2">
          {v.proposedByAssistant ? 'drafted by the assistant for' : 'by'}
          {v.author} · {dateTime(v.createdAt)}{v.reviewer && v.proposedByAssistant
            ? ` · ${v.status} by ${v.reviewer}`
            : ''}{v.note ? ` · ${v.note}` : ''}
        </span>
      </li>
    {/each}
  </ul>
</section>
