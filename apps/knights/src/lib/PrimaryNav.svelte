<script lang="ts">
  import { page } from '$app/state';
  import Icon from '$lib/Icon.svelte';
  import { activeHref, NAV_ITEMS } from '$lib/nav';

  let active = $derived(activeHref(page.url.pathname));
</script>

<nav aria-label="Primary">
  <ul>
    {#each NAV_ITEMS as item (item.href)}
      <li>
        <!-- Hover-prefetching /play would consume a feed item. -->
        <a
          href={item.href}
          aria-current={item.href === active ? 'page' : undefined}
          data-sveltekit-preload-data={item.href === '/play' ? 'off' : undefined}
        >
          <Icon name={item.icon} size={18} />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  nav {
    margin-right: auto;
    align-self: stretch;
  }
  ul {
    display: flex;
    align-items: stretch;
    gap: 4px;
    height: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
  }
  a {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    color: var(--io-parchment-muted);
    font: 700 13px/1 var(--io-font-display);
    letter-spacing: 2px;
    text-decoration: none;
    text-transform: uppercase;
    transition: color var(--motion-fast) var(--ease-out-quart);
  }
  a :global(svg) {
    color: var(--io-gold-muted);
    transition: color var(--motion-fast) var(--ease-out-quart);
  }
  a::after {
    content: '';
    position: absolute;
    inset: auto 12px -1px;
    height: 2px;
    background: var(--io-gold);
    opacity: 0;
    transform: scaleX(0.4);
    transition: opacity var(--motion-base) var(--ease-out-quart),
      transform var(--motion-base) var(--ease-out-quart);
  }
  a::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, color-mix(in srgb, var(--io-gold) 16%, transparent), transparent 85%);
    opacity: 0;
    transition: opacity var(--motion-base) var(--ease-out-quart);
    pointer-events: none;
  }
  a:hover {
    color: var(--io-parchment);
  }
  a:hover :global(svg) {
    color: var(--io-gold);
  }
  a[aria-current='page'] {
    color: var(--io-gold);
  }
  a[aria-current='page'] :global(svg) {
    color: var(--io-gold);
  }
  a[aria-current='page']::after {
    opacity: 1;
    transform: none;
  }
  a[aria-current='page']::before {
    opacity: 1;
  }
  a:focus-visible {
    outline-offset: -4px;
  }

  @media (min-width: 75.0625rem) {
    a :global(svg) {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    a,
    a::before,
    a::after,
    a :global(svg) {
      transition: none;
    }
  }

  /* Below 75rem the header's stats and account menu leave no room for four tabs. */
  @media (max-width: 75rem) {
    nav {
      position: fixed;
      inset: auto 0 0;
      z-index: 15;
      margin: 0;
      padding-bottom: env(safe-area-inset-bottom);
      border-top: 1px solid var(--io-gold-muted);
      background: var(--io-surface);
      box-shadow: 0 -8px 24px #000000aa;
    }
    ul {
      gap: 0;
      height: auto;
    }
    li {
      flex: 1;
    }
    a {
      flex: 1;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
      min-height: 56px;
      padding: 6px 4px;
      font-size: 10px;
      letter-spacing: 1.5px;
    }
    a::after {
      inset: -1px 25% auto;
    }
    a::before {
      background: linear-gradient(to bottom, color-mix(in srgb, var(--io-gold) 16%, transparent), transparent 85%);
    }
  }
</style>
