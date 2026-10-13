<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Sheet from '@civitai/ui/components/ui/sheet/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import DiffView from '$lib/components/text-scan-lab/DiffView.svelte';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ChangesState } from './changes';

  let {
    promptKey,
    changes,
    current,
    currentError,
    onclose,
  }: {
    promptKey: PromptKey | null;
    changes: ChangesState;
    current: Partial<Record<PromptKey, string>>;
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
  const stale = $derived(key !== null && changes.stale.includes(key));
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
          Your version is kept in this browser. Nobody else sees it until you publish it.
        </Sheet.Description>
      </Sheet.Header>

      {#if stale && key}
        <div class="rounded-md border border-amber-500/40 p-3 text-sm text-amber-300">
          <p>
            Written against an older version — someone has published since. Review the differences
            from the current version, then keep your text or discard it.
          </p>
          <div class="mt-2 flex gap-2">
            <Button size="xs" variant="outline" onclick={() => key && changes.keepMine(key)}>
              Keep my text
            </Button>
            <Button size="xs" variant="ghost" onclick={() => key && changes.drop([key])}>
              Discard
            </Button>
          </div>
        </div>
      {/if}

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
            Your version
          </Label>
          <div class="flex gap-2">
            {#if changed && currentText !== undefined}
              <Button size="xs" variant="ghost" onclick={() => (showDiff = !showDiff)}>
                {showDiff ? 'Hide differences' : 'Show differences'}
              </Button>
            {/if}
            {#if changed}
              <Button size="xs" variant="ghost" onclick={() => key && changes.drop([key])}>
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
            class="mt-2 min-h-96 font-mono text-xs"
            bind:value={() => mine ?? '', (v) => key && changes.set(key, v)}
          />
        {/if}
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
