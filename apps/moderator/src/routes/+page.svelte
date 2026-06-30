<script lang="ts">
  import { buildWordmarkSvg } from '@civitai/brand';
  import { IconShieldCheck } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const wordmarkSvg = buildWordmarkSvg({ base: '#e8eaed' });
  const who = $derived(data.moderator.username ?? `user #${data.moderator.id}`);
</script>

<main class="shell">
  <header class="brand">
    <span class="wordmark">{@html wordmarkSvg}</span>
    <span class="tag">moderator</span>
  </header>

  <section class="card">
    <IconShieldCheck size={32} stroke={1.5} />
    <div>
      <h1>Moderator app</h1>
      <p>
        A SvelteKit app in <code>apps/moderator</code>, wired to the shared
        <code>@civitai/*</code> packages. Auth runs as a <code>*.civitai.com</code> spoke — only
        moderators reach this page.
      </p>
      <p class="who">Signed in as <strong>{who}</strong></p>
    </div>
  </section>
</main>

<style>
  .shell {
    max-width: 720px;
    margin: 0 auto;
    padding: 64px 24px;
    font-family: system-ui, sans-serif;
    color: #e8eaed;
  }
  :global(body) {
    background: #1a1b1e;
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 32px;
  }
  .wordmark :global(svg) {
    height: 28px;
    width: auto;
    display: block;
  }
  .tag {
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #909296;
  }
  .card {
    display: flex;
    gap: 16px;
    padding: 24px;
    border: 1px solid #2c2e33;
    border-radius: 12px;
    background: #25262b;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
  }
  p {
    margin: 0 0 8px;
    color: #c1c2c5;
    line-height: 1.55;
  }
  .who {
    margin-top: 12px;
    color: #909296;
  }
  code {
    background: #1a1b1e;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.9em;
  }
</style>
