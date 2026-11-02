<script lang="ts">
  import '../global.css';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  let avatarFailed = $state(false);
</script>

<nav aria-label="Site">
  {#if data.player}
    <a class="player" href={data.player.profileUrl} title={data.player.username}>
      {#if data.player.avatarUrl && !avatarFailed}
        <img
          src={data.player.avatarUrl}
          alt=""
          width="24"
          height="24"
          loading="lazy"
          onerror={() => (avatarFailed = true)}
        />
      {:else}
        <span class="initial" aria-hidden="true">{data.player.username[0].toUpperCase()}</span>
      {/if}
      <span class="name">{data.player.username}</span>
    </a>
  {/if}
  <div class="links">
    <a href={data.civitaiUrl}>Back to Civitai</a>
    <a href="/logout" data-sveltekit-reload>Sign out</a>
  </div>
</nav>

<main>
  {@render children()}
</main>

<style>
  nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    max-width: 48rem;
    margin: 0 auto;
    padding: 0.75rem 1.5rem 0;
    font-size: 0.85rem;
  }
  nav a {
    color: var(--muted);
  }
  .links {
    display: flex;
    gap: 1rem;
    margin-left: auto;
    white-space: nowrap;
  }
  .player {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .player img,
  .initial {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }
  .player img {
    object-fit: cover;
  }
  .initial {
    display: grid;
    place-items: center;
    background: var(--border, #333);
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 3rem;
  }
  @media (max-width: 40rem) {
    nav {
      gap: 0.5rem;
      padding: 0 1rem;
    }
    nav a {
      padding: 0.6rem 0;
    }
    .links {
      gap: 0.75rem;
    }
    main {
      padding: 0 1rem 1rem;
    }
  }
</style>
