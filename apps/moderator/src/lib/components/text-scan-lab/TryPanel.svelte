<script lang="ts">
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { itemChanged, runIsStale, type TryResult } from '$lib/text-scan-lab/try';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { Workspace } from '$lib/text-scan-tests/types';
  import PromptSent from './PromptSent.svelte';
  import TryForm from './TryForm.svelte';
  import TryItemCard from './TryItemCard.svelte';

  let {
    prompts,
    editedKeys,
    draftsError,
    onedit = null,
    workspace,
    canCapture,
  }: {
    prompts: string;
    editedKeys: readonly PromptKey[];
    draftsError: string | null;
    onedit?: ((key: PromptKey) => void) | null;
    workspace: Workspace;
    canCapture: boolean;
  } = $props();

  let result = $state<TryResult | null>(null);
  let ranWith = $state<string | null>(null);
  let onlyChanged = $state(false);

  const drafts = $derived(prompts);
  const changed = $derived(
    result ? result.items.filter((item) => itemChanged(item, result!.labels)) : []
  );
  const visible = $derived(result ? (onlyChanged && result.edited ? changed : result.items) : []);
  const capture = $derived(
    canCapture && result ? { workspace, entityType: result.entityType } : null
  );
  const sides = $derived(
    result
      ? [
          { title: 'Current', system: result.current.system },
          ...(result.edited ? [{ title: 'Edited', system: result.edited.system }] : []),
        ]
      : []
  );
</script>

<section class="min-w-0 space-y-4" aria-label="Try">
  <TryForm
    {prompts}
    {editedKeys}
    {draftsError}
    onstart={() => {
      result = null;
      ranWith = drafts;
    }}
    onresult={(r) => (result = r as TryResult)}
  />

  {#if result}
    {#if result.notice}
      <p class="text-sm text-amber-300">{result.notice}</p>
    {/if}
    {#if result.skipped.length}
      <p class="whitespace-pre-wrap text-sm text-amber-300">
        Couldn't load: {result.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
      </p>
    {/if}
    {#if runIsStale(ranWith, drafts)}
      <p class="text-sm text-amber-300">
        Your drafts changed after this run (an edit or a save), so it no longer shows their effect.
        Run it again.
      </p>
    {/if}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs text-dark-2">
        {result.items.length} item{result.items.length === 1 ? '' : 's'}{#if result.edited}
          · {changed.length} changed{/if}
      </p>
      {#if result.edited}
        <div class="flex items-center gap-2">
          <Switch id="try-only-changed" bind:checked={onlyChanged} />
          <Label for="try-only-changed" class="text-xs text-dark-2">Changed only</Label>
        </div>
      {/if}
    </div>
    <PromptSent {sides} />
    {#each visible as item (item.key)}
      <TryItemCard
        {item}
        labels={result.labels}
        {onedit}
        {capture}
      />
    {/each}
    {#if onlyChanged && result.edited && !changed.length}
      <p class="text-sm text-dark-2">No verdict changed.</p>
    {/if}
  {/if}
</section>
