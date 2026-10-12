<script lang="ts">
  import * as Collapsible from '@civitai/ui/components/ui/collapsible/index.js';
  import * as NativeSelect from '@civitai/ui/components/ui/native-select/index.js';
  import { LINK_CLASS } from '$lib/format';
  import type { LabPrompts } from '$lib/server/text-scan-lab/harness-client';
  import { defaultComparePair } from '$lib/text-scan-lab/compare';
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

  let picked = $state<{ from: number | null; to: number | null }>({ from: null, to: null });
  const defaults = $derived(defaultComparePair(history));
  const pickVersion = (id: number | null | undefined, fallback: number | undefined) =>
    history.find((v) => v.id === id) ?? history.find((v) => v.id === fallback);
  const compareFrom = $derived(pickVersion(picked.from, defaults?.from));
  const compareTo = $derived(pickVersion(picked.to, defaults?.to));

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

  {#if defaults}
    <h3 class="mt-5 text-xs font-semibold tracking-wide text-dark-2 uppercase">Compare</h3>
    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-dark-2">
      {#snippet versionOptions()}
        {#each history as v (v.id)}
          <NativeSelect.Option value={v.id}>
            #{v.id} · {when(v.createdAt)} · {author(v.createdById)}
          </NativeSelect.Option>
        {/each}
      {/snippet}
      <NativeSelect.Root
        aria-label="Compare from"
        value={compareFrom?.id}
        onchange={(e) => (picked.from = Number(e.currentTarget.value))}
      >
        {@render versionOptions()}
      </NativeSelect.Root>
      <span>to</span>
      <NativeSelect.Root
        aria-label="Compare to"
        value={compareTo?.id}
        onchange={(e) => (picked.to = Number(e.currentTarget.value))}
      >
        {@render versionOptions()}
      </NativeSelect.Root>
    </div>
    {#if compareFrom && compareTo}
      <div class="mt-2">
        <DiffView before={compareFrom.content} after={compareTo.content} />
      </div>
    {/if}
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
              <p class="mb-2 text-xs">
                <a href="/text-scan/check?key={promptKey}&from={version.id}" class={LINK_CLASS}
                  >Edit in Check</a
                >
              </p>
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
