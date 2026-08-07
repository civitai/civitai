<script lang="ts">
  import { LINK_CLASS } from '$lib/format';

  // `capped` is the whole reason this is a component rather than eight copies of a button. When the
  // server truncated the set, "Show all N" is a lie — N is what was loaded, not what exists — and that
  // rule lived only in whether the author remembered it. Two call sites had already got it wrong.
  let {
    total,
    shown,
    expanded,
    capped = false,
    onToggle,
  }: {
    total: number;
    shown: number;
    expanded: boolean;
    capped?: boolean;
    onToggle: () => void;
  } = $props();
</script>

{#if total > shown}
  <button type="button" class="mt-3 text-sm {LINK_CLASS}" onclick={onToggle}>
    {expanded ? 'Show less' : capped ? `Show ${total} loaded` : `Show all ${total}`}
  </button>
{/if}
