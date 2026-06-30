<script lang="ts">
  import { IconFlag, IconPhoto, IconUsers } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const name = $derived(data.user?.username ?? 'moderator');

  const stats = [
    { label: 'Open reports', value: '—', icon: IconFlag, href: '/reports' },
    { label: 'Images to review', value: '—', icon: IconPhoto, href: '/images' },
    { label: 'Flagged users', value: '—', icon: IconUsers, href: '/users' },
  ];
</script>

<header class="page-header">
  <h1>Dashboard</h1>
  <p>Welcome back, {name}.</p>
</header>

<section class="mb-8 rounded-xl border border-dark-4 bg-dark-6 p-5">
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
      <div class="mb-1.5 text-xs font-medium uppercase tracking-wider text-dark-2">Features</div>
      {#if data.features.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each data.features as feature (feature)}
            <span class="rounded bg-dark-7 px-2 py-0.5 text-xs text-dark-1">{feature}</span>
          {/each}
        </div>
      {:else}
        <span class="text-sm text-dark-3">None.</span>
      {/if}
    </div>
  </div>
</section>

<section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
  {#each stats as stat (stat.label)}
    {@const Icon = stat.icon}
    <a
      href={stat.href}
      class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5 transition-colors hover:border-dark-3"
    >
      <span class="grid size-9 place-items-center rounded-lg bg-blue-8/15 text-blue-4">
        <Icon size={20} stroke={1.5} />
      </span>
      <span class="text-3xl font-semibold text-white">{stat.value}</span>
      <span class="text-sm text-dark-2">{stat.label}</span>
    </a>
  {/each}
</section>
