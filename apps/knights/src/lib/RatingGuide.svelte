<script lang="ts">
  let { guide }: { guide: { level: number; label: string; description: string }[] } = $props();
</script>

<dl>
  {#each guide as entry (entry.level)}
    <dt>{entry.label}</dt>
    <dd>{entry.description}</dd>
  {/each}
</dl>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.5rem 1.5rem;
  }
  dt {
    color: var(--gold);
  }
  dd {
    margin: 0;
  }
  @media (max-width: 40rem) {
    dl {
      grid-template-columns: 1fr;
      gap: 0.1rem;
    }
    dd {
      margin-bottom: 0.6rem;
    }
  }
</style>
