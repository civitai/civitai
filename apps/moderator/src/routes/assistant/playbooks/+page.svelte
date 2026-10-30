<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import PlaybookFields from './PlaybookFields.svelte';
  import ToolList from './ToolList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const canEdit = $derived(!!data.grants['assistant.use']);
  const create = new FormState({ onSuccess: null });
</script>

<h2 class="m-0 mb-1 text-base font-semibold text-white">Playbooks</h2>
<p class="mb-4 text-sm text-dark-2">
  How to investigate a kind of case, step by step. The assistant sees every playbook’s one-line summary
  and reads the steps of the one that fits. Edits apply to the next question asked; drafts the assistant
  writes wait here until a moderator accepts them.
</p>

{#if data.storeError}
  <ErrorAlert message={data.storeError} class="mb-4" />
{:else if data.playbooks.length || data.unserved.length}
  <ul class="mb-6 space-y-3">
    {#each data.unserved as p (p.slug)}
      <li class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <a href="/assistant/playbooks/{p.slug}" class="font-medium {LINK_CLASS}">{p.title}</a>
          <code class="text-xs text-dark-2">{p.slug}</code>
          <Badge variant="outline">
            {p.archived ? 'archived' : p.pending ? `draft, ${p.pending} to review` : 'no accepted version'}
          </Badge>
        </div>
        <p class="mt-1 mb-0 text-sm text-dark-2">Not used by the assistant.</p>
      </li>
    {/each}
    {#each data.playbooks as p (p.slug)}
      <li class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <a href="/assistant/playbooks/{p.slug}" class="font-medium {LINK_CLASS}">{p.title}</a>
          <code class="text-xs text-dark-2">{p.slug} v{p.version}</code>
          {#if p.pending}<Badge variant="outline">{p.pending} to review</Badge>{/if}
        </div>
        <p class="mt-1 mb-0 text-sm text-dark-2">{p.summary}</p>
      </li>
    {/each}
  </ul>
{:else}
  <p class="mb-6 text-sm text-dark-2">No playbooks yet.</p>
{/if}

{#if canEdit && !data.storeError}
  <details class="rounded-xl border border-dark-4 bg-dark-6 p-4">
    <summary class="text-sm font-semibold text-white">New playbook</summary>
    <form method="POST" action="?/create" use:enhance={create.enhance} class="mt-4 space-y-3">
      <div>
        <Label for="pb-slug" class="text-xs text-dark-2">Name (lowercase-with-hyphens, never changes)</Label>
        <Input id="pb-slug" name="slug" maxlength={60} required pattern={'[a-z0-9]+(-[a-z0-9]+)*'} />
      </div>
      <PlaybookFields />
      <ToolList tools={data.tools} />
      {#if create.error}<ErrorAlert message={create.error} />{/if}
      <Button type="submit" disabled={create.submitting}>Save playbook</Button>
    </form>
  </details>
{/if}
