<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

  let {
    overrides = $bindable(),
    active,
  }: {
    overrides: Partial<Record<PromptKey, string>>;
    /** Active prompt text by key, to start an override from; null when it could not be loaded. */
    active: Record<string, string> | null;
  } = $props();

  const included = $derived(PROMPT_KEYS.filter((k) => k in overrides));
  const available = $derived(PROMPT_KEYS.filter((k) => !(k in overrides)));

  function remove(key: PromptKey) {
    const { [key]: _removed, ...rest } = overrides;
    overrides = rest;
  }
</script>

<div class="space-y-3">
  <p class="text-xs text-dark-2">
    Not saved. A key left out runs active; a key included must not be empty.
    {#if !active}<span class="text-amber-300">Active prompts could not be loaded to start from.</span
      >{/if}
  </p>

  {#each included as key (key)}
    <div>
      <div class="flex items-center justify-between">
        <Label for="override-{key}" class="text-xs text-dark-2">{key} override</Label>
        <Button size="xs" variant="ghost" onclick={() => remove(key)}>Remove</Button>
      </div>
      <Textarea
        id="override-{key}"
        class="mt-1 min-h-40 font-mono text-xs"
        bind:value={() => overrides[key] ?? '', (v) => (overrides = { ...overrides, [key]: v })}
      />
    </div>
  {/each}

  {#if available.length}
    <div class="flex flex-wrap gap-2">
      {#each available as key (key)}
        <Button
          size="xs"
          variant="outline"
          onclick={() => (overrides = { ...overrides, [key]: active?.[key] ?? '' })}
        >
          Override {key}
        </Button>
      {/each}
    </div>
  {/if}
</div>
