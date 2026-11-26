<script lang="ts" module>
  export const TAP_TARGET = "relative after:absolute after:-inset-2 after:content-['']";
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { portalProps } from '$lib/host';

  let {
    label,
    class: className = '',
    contentClass = 'max-w-[240px] text-xs',
    children,
    content,
  }: {
    label?: string;
    class?: string;
    contentClass?: string;
    children: Snippet;
    content: Snippet;
  } = $props();

  let open = $state(false);
</script>

<!-- bits-ui tooltips ignore touch pointers and close on trigger click, and a tap's focus opens them
     just before that click, so taps never stuck. The click toggle owns tap and click; pointer focus is
     ignored so it can't race it. Pass TAP_TARGET in `class` to widen a tiny icon trigger. -->
<Tooltip.Provider>
  <Tooltip.Root bind:open disableCloseOnTriggerClick ignoreNonKeyboardFocus>
    <Tooltip.Trigger
      type="button"
      class={className}
      aria-label={label}
      onclick={() => (open = !open)}
    >
      {@render children()}
    </Tooltip.Trigger>
    <Tooltip.Content class={contentClass} portalProps={portalProps()}>
      {@render content()}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
