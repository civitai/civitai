<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<h1>Knights of New Order</h1>

{#if data.player}
  <p>Welcome back{data.username ? `, ${data.username}` : ''}.</p>
  <dl>
    <dt>Rank</dt>
    <dd>{data.player.rankType}</dd>
    <dt>Experience</dt>
    <dd>{data.player.exp}</dd>
    <dt>Fervor</dt>
    <dd>{data.player.fervor}</dd>
    <dt>Sworn in</dt>
    <dd>{new Date(data.player.startAt).toLocaleDateString()}</dd>
  </dl>
{:else}
  <p>You have not joined the Order yet.</p>
{/if}

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1.5rem;
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
</style>
