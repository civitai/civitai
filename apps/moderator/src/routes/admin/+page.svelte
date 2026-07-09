<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Permissions</h1>
  <p>Moderator roles are hierarchical — each tier adds pages and inherits everything below it. Roles are assigned in the auth hub; editing this mapping here is coming soon.</p>
</header>

<ol class="space-y-3">
  {#each [...data.hierarchy].reverse() as tier, i (tier.role)}
    <li class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="flex items-baseline justify-between gap-3">
        <code class="text-sm text-blue-4">{tier.role}</code>
        {#if i < data.hierarchy.length - 1}
          <span class="text-xs text-dark-3">+ everything below</span>
        {/if}
      </div>
      <ul class="mt-3 space-y-1.5">
        {#each tier.navigation as link (link.path)}
          <li class="flex items-baseline justify-between gap-3 text-sm">
            <span class="text-dark-0">{link.label}</span>
            <code class="text-xs text-dark-3">{link.path}</code>
          </li>
        {/each}
      </ul>
    </li>
  {/each}
</ol>
