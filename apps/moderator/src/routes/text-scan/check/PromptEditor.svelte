<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Sheet from '@civitai/ui/components/ui/sheet/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import DiffView from '$lib/components/text-scan-lab/DiffView.svelte';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ChangesState } from './changes';
  import SaveStatus from './SaveStatus.svelte';

  let {
    promptKey,
    changes,
    current,
    currentError,
    onclose,
  }: {
    /** The prompt being edited; null closes the drawer. */
    promptKey: PromptKey | null;
    changes: ChangesState;
    current: Partial<Record<PromptKey, string>>;
    /** Why the current prompts could not be loaded, if they could not. */
    currentError: string | null;
    onclose: () => void;
  } = $props();

  let showDiff = $state(false);

  // Kept through the close animation, which would otherwise render an empty drawer.
  let key = $state<PromptKey | null>(null);
  $effect.pre(() => {
    if (promptKey) key = promptKey;
  });
  const currentText = $derived(key ? current[key] : undefined);
  const changed = $derived(key !== null && key in changes.prompts);
  const mine = $derived(key ? changes.prompts[key] ?? currentText : undefined);
</script>

<Sheet.Root
  open={promptKey !== null}
  onOpenChange={(open) => {
    if (!open) onclose();
  }}
>
  <Sheet.Content
    side="right"
    class="overflow-y-auto p-5 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
  >
    {#if key}
      <Sheet.Header class="p-0">
        <Sheet.Title class="text-white">{promptKeyName(key)}</Sheet.Title>
        <Sheet.Description class="text-dark-2">
          {changes.editable
            ? 'Your version saves as you type. Nobody else sees it until you propose or publish it.'
            : 'Read only.'}
        </Sheet.Description>
      </Sheet.Header>

      <details>
        <summary class="text-xs text-dark-2">Current version</summary>
        {#if currentText !== undefined}
          <pre
            class="mt-2 max-h-80 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-3 text-xs leading-5 whitespace-pre-wrap text-dark-0">{currentText}</pre>
        {:else}
          <p class="mt-2 text-sm text-red-300">{currentError ?? 'There is no current version.'}</p>
        {/if}
      </details>

      <div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="prompt-editor" class="text-xs text-dark-2">
            {changes.editable ? 'Your version' : 'This version'}
          </Label>
          <div class="flex gap-2">
            {#if changed && currentText !== undefined}
              <Button size="xs" variant="ghost" onclick={() => (showDiff = !showDiff)}>
                {showDiff ? 'Hide differences' : 'Show differences'}
              </Button>
            {/if}
            {#if changed && changes.editable}
              <Button size="xs" variant="ghost" onclick={() => key && changes.resetKey(key)}>
                Reset to current
              </Button>
            {/if}
          </div>
        </div>
        {#if showDiff && changed && currentText !== undefined}
          <div class="mt-2">
            <DiffView before={currentText} after={mine ?? ''} />
          </div>
        {/if}
        {#if mine === undefined}
          <p class="mt-2 text-sm text-amber-300">
            The current version did not load, so there is nothing to start from — reload to try
            again.
          </p>
        {:else}
          <Textarea
            id="prompt-editor"
            class={cn(
              'mt-2 min-h-96 font-mono text-xs',
              !changes.editable && 'cursor-default bg-dark-7 text-dark-1'
            )}
            readonly={!changes.editable}
            bind:value={() => mine ?? '', (v) => key && changes.set(key, v, currentText)}
          />
        {/if}
      </div>

      {#if changes.editable}
        <SaveStatus {changes} />
      {/if}
    {/if}
  </Sheet.Content>
</Sheet.Root>
