<script lang="ts">
  import * as Collapsible from '@civitai/ui/components/ui/collapsible/index.js';
  import type { LabPrompts } from '$lib/server/text-scan-lab/harness-client';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import DiffView from '$lib/components/text-scan-lab/DiffView.svelte';

  let {
    promptKey,
    prompts,
    authors,
  }: { promptKey: PromptKey; prompts: LabPrompts; authors: Record<number, string> } = $props();

  const active = $derived(prompts.active[promptKey]);
  const history = $derived([...(prompts.history ?? [])].sort((a, b) => b.id - a.id));
  const activeMeta = $derived(history.find((v) => v.id === active?.id));

  const when = (iso: string) => new Date(iso).toLocaleString();
  const author = (id: number | null | undefined) => (id == null ? 'unknown' : authors[id] ?? 'unknown');
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="text-sm font-semibold text-white">Current · {promptKeyName(promptKey)}</h2>
  {#if active}
    <p class="mt-1 text-xs text-dark-2">
      {#if activeMeta}
        Published {when(activeMeta.createdAt)} by {author(activeMeta.createdById)}
      {:else}
        Live version
      {/if}
    </p>
    <pre
      class="mt-3 max-h-[28rem] overflow-auto rounded-md border border-dark-4 bg-dark-7 p-3 text-xs leading-5 whitespace-pre-wrap text-dark-0">{active.content}</pre>
  {:else}
    <p class="mt-2 text-sm text-dark-2">No current version.</p>
  {/if}

  <h3 class="mt-5 text-xs font-semibold tracking-wide text-dark-2 uppercase">History</h3>
  {#if history.length}
    <ul class="mt-2 space-y-2">
      {#each history as version, i (version.id)}
        {@const previous = history[i + 1]}
        <li class="rounded-md border border-dark-4 p-2">
          <Collapsible.Root>
            <Collapsible.Trigger class="flex w-full items-baseline justify-between gap-2 text-left">
              <span class="text-sm text-dark-0">
                {when(version.createdAt)}
                {#if version.id === active?.id}<span class="text-xs text-green-300">current</span>{/if}
              </span>
              <span class="text-xs text-dark-2">
                by {author(version.createdById)}
              </span>
            </Collapsible.Trigger>
            {#if version.note}
              <p class="mt-1 text-xs text-dark-2">{version.note}</p>
            {/if}
            <Collapsible.Content class="mt-2">
              {#if previous}
                <p class="mb-1 text-xs text-dark-2">Changes from the version of {when(previous.createdAt)}</p>
                <DiffView before={previous.content} after={version.content} />
              {:else}
                <!-- The harness returns only the latest versions, so this may not be the first. -->
                <p class="mb-1 text-xs text-dark-2">Earliest version loaded</p>
                <pre
                  class="max-h-96 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2 text-xs leading-5 whitespace-pre-wrap text-dark-0">{version.content}</pre>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-2 text-sm text-dark-2">No history returned.</p>
  {/if}
</section>
