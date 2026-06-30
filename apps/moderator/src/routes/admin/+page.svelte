<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const featureLabel = (key: string) => data.features.find((f) => f.key === key)?.label ?? key;
</script>

<header class="page-header">
  <h1>Role permissions</h1>
  <p>Which features each <code class="rounded bg-dark-7 px-1 text-blue-4">moderator:*</code> role grants. Editing here is coming soon — for now this reflects the in-app configuration.</p>
</header>

<section class="mb-8">
  <h2 class="mb-3 text-base font-semibold text-white">Roles</h2>
  {#if data.roles.length === 0}
    <div class="placeholder">No roles configured.</div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2">
      {#each data.roles as role (role.role)}
        <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
          <code class="text-sm text-blue-4">moderator:{role.role}</code>
          <div class="mt-3 flex flex-wrap gap-1.5">
            {#each role.features as feature (feature)}
              <span class="rounded bg-dark-7 px-2 py-0.5 text-xs text-dark-1">{featureLabel(feature)}</span>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<section>
  <h2 class="mb-3 text-base font-semibold text-white">Features</h2>
  <div class="overflow-hidden rounded-xl border border-dark-4">
    <table class="w-full border-collapse text-sm">
      <thead>
        <tr class="bg-dark-6 text-left text-xs uppercase tracking-wider text-dark-2">
          <th class="px-4 py-2.5 font-medium">Feature</th>
          <th class="px-4 py-2.5 font-medium">Kind</th>
          <th class="px-4 py-2.5 font-medium">Description</th>
        </tr>
      </thead>
      <tbody>
        {#each data.features as feature (feature.key)}
          <tr class="border-t border-dark-4">
            <td class="px-4 py-2.5 text-dark-0">{feature.label} <code class="text-dark-3">{feature.key}</code></td>
            <td class="px-4 py-2.5 text-dark-2">{feature.kind}</td>
            <td class="px-4 py-2.5 text-dark-2">{feature.description}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
