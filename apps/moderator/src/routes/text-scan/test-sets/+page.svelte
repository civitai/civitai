<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, plural } from '$lib/format';

  let { data } = $props();
  const canEdit = $derived(!!data.grants['textScan.testSet.edit']);

  const create = new FormState({
    onSuccess: (r) => {
      if (typeof r?.setId === 'number') void goto(`/text-scan/test-sets/${r.setId}`);
    },
  });
  const archive = new FormState({ onSuccess: null, reload: true });
  const versionName = (v: string) => (v === 'active' ? 'Active' : `Draft #${v}`);
</script>

<svelte:head><title>Text-scan test sets</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Text-scan test sets</h1>
  <a href={data.archived ? '?' : '?archived=1'} class="text-sm {LINK_CLASS}">
    {data.archived ? 'Hide archived' : 'Show archived'}
  </a>
</div>

{#if canEdit}
  <form
    method="POST"
    action="?/createSet"
    use:enhance={create.enhance}
    class="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-dark-4 bg-dark-6 p-5"
  >
    <Input name="name" placeholder="New set name" maxlength={100} required class="w-56" />
    <Input
      name="description"
      placeholder="Description (optional)"
      maxlength={2000}
      class="min-w-40 flex-1"
    />
    <Button type="submit" size="sm" disabled={create.submitting}>Create set</Button>
    {#if create.error}
      <p class="w-full text-sm text-red-300">{create.error}</p>
    {/if}
  </form>
{/if}

{#if archive.error}
  <p class="mb-2 text-sm text-red-300">{archive.error}</p>
{/if}

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  {#if data.sets.length}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Set</Table.Head>
          <Table.Head>Cases</Table.Head>
          <Table.Head>Last run per version</Table.Head>
          {#if canEdit}<Table.Head><span class="sr-only">Actions</span></Table.Head>{/if}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.sets as set (set.id)}
          <Table.Row>
            <Table.Cell class="align-top">
              <a href="/text-scan/test-sets/{set.id}" class={LINK_CLASS}>{set.name}</a>
              {#if set.archivedAt}<Badge variant="outline" class="ml-2">archived</Badge>{/if}
              {#if set.description}
                <p class="mt-1 whitespace-normal text-xs text-dark-2">{set.description}</p>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-dark-0">{plural(set.caseCount, 'case')}</Table.Cell>
            <Table.Cell class="align-top text-xs text-dark-2">
              {#each set.lastRuns as run (run.version)}
                <p>
                  <span class="text-dark-0">{versionName(run.version)}</span> · {run.status} ·
                  {dateTime(run.startedAt)}
                </p>
              {:else}
                Never run
              {/each}
            </Table.Cell>
            {#if canEdit}
              <Table.Cell class="text-right align-top">
                {#if !set.archivedAt}
                  <form method="POST" action="?/archiveSet" use:enhance={archive.enhance}>
                    <input type="hidden" name="setId" value={set.id} />
                    <ConfirmSubmit
                      label="Archive"
                      name="confirm"
                      value="1"
                      count={1}
                      noun="set"
                      submitting={archive.submitting}
                    />
                  </form>
                {/if}
              </Table.Cell>
            {/if}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {:else}
    <p class="text-sm text-dark-2">
      No {data.archived ? '' : 'open '}test sets yet{canEdit ? ' — create one above' : ''}.
    </p>
  {/if}
</section>
