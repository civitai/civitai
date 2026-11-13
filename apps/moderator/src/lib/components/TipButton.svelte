<script lang="ts">
  import { Button, type ButtonProps } from '@civitai/ui/components/ui/button/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';

  // A Button with hover text saying what it does — the action button of a `SelectionBar`. Without a
  // `tip` it is a plain Button, so a component can take an optional tip without two branches.
  let { tip, children, onclick, ...rest }: ButtonProps & { tip?: string } = $props();
</script>

{#if tip}
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <!-- Both handlers run: spread after `props`, the caller's onclick would replace the
               trigger's, which closes the tooltip. -->
          <Button
            {...props}
            {...rest}
            onclick={(e) => {
              (props.onclick as ((e: MouseEvent) => void) | undefined)?.(e);
              (onclick as ((e: MouseEvent) => void) | undefined)?.(e);
            }}
          >
            {@render children?.()}
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content class="max-w-xs">{tip}</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else}
  <Button {...rest} {onclick}>{@render children?.()}</Button>
{/if}
