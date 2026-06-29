<script lang="ts">
  // Admin landing — a thin index that links into the management sub-pages. Add cards here as the admin
  // area grows; today the only section is the first-party spoke-domain registry.
  const sections = [
    {
      href: '/admin/spoke-domains',
      title: 'Spoke Domains',
      desc: 'Manage the TrustedSpokeDomain registry — the hosts allowed to drive first-party OAuth login (consent-skipped + session exchange).',
    },
    {
      href: '/admin/access',
      title: 'OAuth Access',
      desc: 'Gate login per OAuth app (open / testers-only / disabled) and manage the global tester allowlist.',
    },
  ];
</script>

<header class="head">
  <h1>Admin</h1>
  <p>Operational controls for the auth hub.</p>
</header>

<div class="cards">
  {#each sections as s (s.href)}
    <a class="card" href={s.href}>
      <h2>{s.title}</h2>
      <p>{s.desc}</p>
    </a>
  {/each}
</div>

<style>
  .head h1 {
    margin: 0 0 0.25rem;
    font-size: 1.5rem;
  }
  .head p {
    margin: 0 0 1.75rem;
    color: #9aa0a6;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }
  .card {
    display: block;
    padding: 1.1rem 1.25rem;
    border-radius: 12px;
    background: #16181d;
    border: 1px solid #2a2d34;
    text-decoration: none;
    color: inherit;
  }
  .card:hover {
    border-color: #4285f4;
    background: #181b21;
  }
  .card h2 {
    margin: 0 0 0.4rem;
    font-size: 1.05rem;
  }
  .card p {
    margin: 0;
    color: #9aa0a6;
    font-size: 0.875rem;
    line-height: 1.4;
  }
</style>
