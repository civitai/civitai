<script lang="ts">
  import type { Snippet } from 'svelte';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';

  let { class: className = '', children }: { class?: string; children?: Snippet } = $props();
  const uid = $props.id();
  const id = `blue-first-${uid}`;
</script>

<!-- id/for, not a wrapping label: the Checkbox is a button, as elsewhere in the app. -->
<div class="flex items-center gap-2 text-sm {className}">
  <Checkbox {id} bind:checked={() => buzzMode.blueFirst, (v) => buzzMode.setBlueFirst(v)} />
  <label for={id} class="cursor-pointer text-dark-0">
    Spend <span class="text-blue-400">Blue</span> first
  </label>
  {@render children?.()}
</div>
