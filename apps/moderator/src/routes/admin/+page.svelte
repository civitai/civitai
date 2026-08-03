<script lang="ts">
  import { enhance } from '$app/forms';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PageData } from './$types';

  let { data, form }: { data: PageData; form: { error?: string; count?: number } | null } =
    $props();

  const shortRole = (role: string) => role.replace('moderator:', '');

  let working = $state<Record<string, string[]>>({});

  // Re-baseline whenever the server sends fresh state — initial load, and again after a save.
  $effect(() => {
    working = Object.fromEntries(Object.entries(data.granted).map(([p, r]) => [p, [...r]]));
  });

  const has = (path: string, role: string) => (working[path] ?? []).includes(role);

  const rowId = (path: string, role: string) =>
    `grant-${shortRole(role)}-${path.replace(/[^a-z0-9]+/gi, '-')}`;

  const changes = $derived(
    Object.fromEntries(
      Object.entries(working).filter(([path, roles]) => {
        const base: string[] = data.granted[path] ?? [];
        return roles.length !== base.length || roles.some((r) => !base.includes(r));
      })
    )
  );
  const dirty = $derived(Object.keys(changes).length);

  function toggle(path: string, role: string, next: boolean) {
    const roles = new Set(working[path] ?? []);
    if (next) roles.add(role);
    else roles.delete(role);
    working = { ...working, [path]: [...roles] };
  }

  function revert() {
    working = Object.fromEntries(Object.entries(data.granted).map(([p, r]) => [p, [...r]]));
  }
</script>

<header class="page-header">
  <h1>Permissions</h1>
  <p>
    Each role has its own list of pages — they are independent, so granting a page to one role does
    not grant it to any other. A page a role has not been granted is unreachable for that role.
    Admins always reach every page and are not listed. Roles themselves are assigned in the auth hub.
  </p>
</header>

{#if form?.error}
  <div
    class="mb-4 max-w-xl rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
  >
    {form.error}
  </div>
{/if}

<div
  class="sticky top-0 z-10 mb-4 flex items-center gap-3 border-b border-dark-4 bg-dark-7 py-3 text-sm"
>
  <span class="flex-1 text-dark-2">
    {#if dirty}
      {dirty} page{dirty === 1 ? '' : 's'} changed — not saved yet.
    {:else}
      No unsaved changes. Saved changes apply within 30 seconds across all servers.
    {/if}
  </span>
  <Button variant="outline" size="sm" disabled={!dirty} onclick={revert}>Revert</Button>
  <form method="POST" action="?/save" use:enhance>
    <input type="hidden" name="changes" value={JSON.stringify(changes)} />
    <Button type="submit" size="sm" disabled={!dirty}>Save</Button>
  </form>
</div>

<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
  {#each data.roles as role (role)}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h2 class="mb-3 text-sm font-semibold text-blue-4">{shortRole(role)}</h2>
      <ul class="space-y-2">
        {#each data.pages as page (page.path)}
          <li class="flex items-center gap-2.5 text-sm" style="padding-left: {page.depth}rem">
            {#if page.group}
              <span class="pt-1 text-xs font-medium tracking-wide text-dark-3 uppercase">
                {page.label}
              </span>
            {:else}
              <Checkbox
                id={rowId(page.path, role)}
                checked={has(page.path, role)}
                onCheckedChange={(next) => toggle(page.path, role, next)}
              />
              <Label for={rowId(page.path, role)} class="cursor-pointer font-normal text-dark-0">
                {page.label}
              </Label>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
