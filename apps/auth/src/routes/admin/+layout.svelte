<script lang="ts">
  import { page } from '$app/state';
  import { buildWordmarkSvg } from '@civitai/brand';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmarkSvg = buildWordmarkSvg({ base: '#e8eaed' });

  const nav = [
    { href: '/admin', label: 'Overview' },
    { href: '/admin/spoke-domains', label: 'Spoke Domains' },
    { href: '/admin/access', label: 'OAuth Access' },
    { href: '/admin/roles', label: 'Roles' },
  ];

  // Active when the path matches exactly, or (for sub-sections) starts with the nav href + '/'.
  const isActive = (href: string, path: string) =>
    path === href || (href !== '/admin' && path.startsWith(href + '/'));
</script>

<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="/admin" aria-label="Civitai admin">
      <span class="wordmark">{@html wordmarkSvg}</span>
      <span class="tag">admin</span>
    </a>

    <nav>
      {#each nav as item (item.href)}
        <a href={item.href} class="nav-link" class:active={isActive(item.href, page.url.pathname)}>
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="who">
      <span class="uid">
        {data.admin.username ?? `user #${data.admin.id}`}
      </span>
      <!-- POST (not a GET link) so logout matches the login page's form and isn't CSRF-able via a bare GET. -->
      <form method="POST" action="/logout" class="logout-form">
        <button type="submit" class="logout">Sign out</button>
      </form>
    </div>
  </aside>

  <main class="content">
    {@render children()}
  </main>
</div>

<style>
  :global(html),
  :global(body) {
    height: 100%;
  }
  .shell {
    min-height: 100%;
    display: grid;
    grid-template-columns: 220px 1fr;
    background: #0b0c10;
    color: #e8eaed;
    font-family: system-ui, sans-serif;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.25rem 1rem;
    background: #16181d;
    border-right: 1px solid #2a2d34;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    text-decoration: none;
    color: inherit;
  }
  .wordmark {
    display: inline-flex;
    width: 104px;
  }
  .wordmark :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .tag {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #0b0c10;
    background: #4285f4;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .nav-link {
    padding: 0.5rem 0.65rem;
    border-radius: 8px;
    text-decoration: none;
    color: #c8ccd0;
    font-size: 0.9rem;
    font-weight: 500;
  }
  .nav-link:hover {
    background: #1b1e24;
    color: #e8eaed;
  }
  .nav-link.active {
    background: #1f2937;
    color: #fff;
  }
  .who {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: #9aa0a6;
  }
  .uid {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .logout-form {
    display: inline;
  }
  .logout {
    /* styled to read as the former text link, but it's a real submit button */
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    cursor: pointer;
    color: #9aa0a6;
    text-decoration: none;
  }
  .logout:hover {
    color: #e8eaed;
    text-decoration: underline;
  }
  .content {
    padding: 2rem 2.25rem;
    overflow: auto;
  }
</style>
