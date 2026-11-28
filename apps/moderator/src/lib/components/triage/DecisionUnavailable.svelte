<script lang="ts">
  /** Why decision buttons are disabled, as text: a disabled button takes no pointer events, so a
   *  `title` on it never shows, and touch has no hover. Blanks and repeats are dropped. */
  let { id, reasons }: { id: string; reasons: (string | null | undefined)[] } = $props();

  const unique = $derived([...new Set(reasons.filter((r): r is string => !!r))]);
</script>

{#if unique.length}
  <p {id} data-testid="decision-unavailable" class="m-0 text-xs text-amber-300">{unique.join(' ')}</p>
{/if}
