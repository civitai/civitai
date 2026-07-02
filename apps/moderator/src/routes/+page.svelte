<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const name = $derived(data.user?.username ?? 'moderator');
  const pages = $derived(data.navGroups.flatMap((g) => g.links).filter((l) => l.path !== '/'));
</script>

<header class="page-header">
  <h1>Dashboard</h1>
  <p>Welcome back, {name}.</p>
</header>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-base font-semibold text-white">Your access</h2>
  <div class="flex flex-col gap-3 sm:flex-row sm:gap-10">
    <div>
      <div class="mb-1.5 text-xs font-medium uppercase tracking-wider text-dark-2">Roles</div>
      {#if data.roles.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each data.roles as role (role)}
            <span class="rounded bg-blue-8/15 px-2 py-0.5 text-xs font-medium text-blue-4">{role}</span>
          {/each}
        </div>
      {:else}
        <span class="text-sm text-dark-3">None — assigned in the auth hub.</span>
      {/if}
    </div>
    <div>
      <div class="mb-1.5 text-xs font-medium uppercase tracking-wider text-dark-2">Pages</div>
      {#if pages.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each pages as link (link.path)}
            <a href={link.path} class="rounded bg-dark-7 px-2 py-0.5 text-xs text-dark-1 hover:text-dark-0">
              {link.label}
            </a>
          {/each}
        </div>
      {:else}
        <span class="text-sm text-dark-3">No additional pages yet.</span>
      {/if}
    </div>
  </div>
</section>
