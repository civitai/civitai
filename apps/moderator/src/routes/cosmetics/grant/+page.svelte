<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconX } from '@tabler/icons-svelte';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { MultiCombobox } from '@civitai/ui/components/ui/multi-combobox/index.js';
  import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
  } from '@civitai/ui/components/ui/pagination/index.js';
  import CosmeticSample from '$lib/components/CosmeticSample.svelte';
  import { cosmeticTypeFilters, humanizeCosmeticType } from '$lib/cosmetics';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(data.totalItems / data.limit)));

  // Selections persist across pagination/filtering (the page component is reused on param navigations).
  const selectedCosmetics = new SvelteMap<number, string>();
  const selectedUsers = new SvelteMap<number, string>();

  const allOnPage = $derived(
    data.items.length > 0 && data.items.every((c) => selectedCosmetics.has(c.id))
  );
  const someOnPage = $derived(data.items.some((c) => selectedCosmetics.has(c.id)));

  function toggleCosmetic(c: { id: number; name: string }) {
    if (selectedCosmetics.has(c.id)) selectedCosmetics.delete(c.id);
    else selectedCosmetics.set(c.id, c.name);
  }
  function toggleAllOnPage() {
    if (allOnPage) for (const c of data.items) selectedCosmetics.delete(c.id);
    else for (const c of data.items) selectedCosmetics.set(c.id, c.name);
  }

  // User typeahead — debounced fetch of the same-app search endpoint.
  let userQuery = $state('');
  let userResults = $state<{ id: number; username: string | null; image: string | null }[]>([]);
  let timer: ReturnType<typeof setTimeout>;
  function onUserInput(e: Event) {
    userQuery = (e.currentTarget as HTMLInputElement).value;
    clearTimeout(timer);
    const q = userQuery.trim();
    if (!q) {
      userResults = [];
      return;
    }
    timer = setTimeout(async () => {
      const res = await fetch(`/cosmetics/grant/users?q=${encodeURIComponent(q)}`);
      userResults = res.ok ? await res.json() : [];
    }, 300);
  }
  function addUser(u: { id: number; username: string | null }) {
    if (u.username) selectedUsers.set(u.id, u.username);
    userQuery = '';
    userResults = [];
  }

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }
  function applyName(e: SubmitEvent) {
    e.preventDefault();
    const value = new FormData(e.currentTarget as HTMLFormElement).get('name');
    goto(urlWith({ name: String(value ?? '').trim() || null, page: 1 }));
  }
  function applyTypes(values: string[]) {
    const url = new URL(page.url);
    url.searchParams.delete('type');
    values.forEach((v) => url.searchParams.append('type', v));
    url.searchParams.set('page', '1');
    goto(url.pathname + url.search);
  }

  const grantCount = $derived(selectedCosmetics.size * selectedUsers.size);

  const grantEnhance: SubmitFunction = ({ cancel }) => {
    if (
      !confirm(
        `Grant ${selectedCosmetics.size} cosmetic(s) × ${selectedUsers.size} user(s) = ${grantCount} grants? Already-owned pairs are skipped.`
      )
    ) {
      cancel();
      return;
    }
    return async ({ result, update }) => {
      if (result.type === 'success') {
        selectedCosmetics.clear();
        selectedUsers.clear();
      }
      // Apply the action result (banner) without refetching the cosmetics list — grant doesn't change it.
      await update({ invalidateAll: false });
    };
  };
</script>

<header class="page-header">
  <h1>Grant Cosmetics</h1>
  <p class="text-sm text-muted-foreground">
    Select cosmetics and users, then grant every selected cosmetic to every selected user.
    Already-owned cosmetics are skipped.
  </p>
</header>

{#if form?.error}
  <div class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
    {form.error}
  </div>
{:else if form?.success}
  <div class="mb-4 rounded-md border border-teal-500/30 bg-teal-500/10 p-2 text-sm text-teal-300">
    {form.newlyGranted} of {form.totalPairs} grants applied{form.alreadyOwned > 0
      ? `, ${form.alreadyOwned} already owned`
      : ''}.
  </div>
{/if}

<div class="mb-6 grid gap-4 rounded-xl border p-4 md:grid-cols-2">
  <div class="flex flex-col gap-2">
    <span class="text-sm font-medium">Cosmetics ({selectedCosmetics.size} selected)</span>
    {#if selectedCosmetics.size > 0}
      <div class="flex flex-wrap gap-1">
        {#each [...selectedCosmetics] as [id, name] (id)}
          <Badge variant="secondary" class="gap-1">
            {name}
            <button type="button" aria-label={`Remove ${name}`} onclick={() => selectedCosmetics.delete(id)}>
              <IconX size={12} />
            </button>
          </Badge>
        {/each}
      </div>
    {:else}
      <span class="text-sm text-muted-foreground">Select cosmetics from the list below.</span>
    {/if}
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-sm font-medium">Users ({selectedUsers.size} selected)</span>
    <div class="relative">
      <Input
        value={userQuery}
        oninput={onUserInput}
        placeholder="Search users by username…"
        class="h-8"
      />
      {#if userResults.length > 0}
        <div class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow">
          {#each userResults as u (u.id)}
            <button
              type="button"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
              disabled={selectedUsers.has(u.id) || !u.username}
              onclick={() => addUser(u)}
            >
              {u.username ?? `User #${u.id}`}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    {#if selectedUsers.size > 0}
      <div class="flex flex-wrap gap-1">
        {#each [...selectedUsers] as [id, username] (id)}
          <Badge variant="secondary" class="gap-1">
            {username}
            <button type="button" aria-label={`Remove ${username}`} onclick={() => selectedUsers.delete(id)}>
              <IconX size={12} />
            </button>
          </Badge>
        {/each}
      </div>
    {/if}
  </div>

  <form method="POST" action="?/grant" use:enhance={grantEnhance} class="md:col-span-2">
    {#each [...selectedCosmetics.keys()] as id (id)}
      <input type="hidden" name="cosmeticId" value={id} />
    {/each}
    {#each [...selectedUsers.keys()] as id (id)}
      <input type="hidden" name="userId" value={id} />
    {/each}
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm text-muted-foreground">
        {grantCount > 0
          ? `${selectedCosmetics.size} cosmetic(s) × ${selectedUsers.size} user(s) = ${grantCount} grants`
          : 'Select at least one cosmetic and one user'}
      </span>
      <Button type="submit" disabled={grantCount === 0}>Grant Cosmetics</Button>
    </div>
  </form>
</div>

<div class="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3">
  <form class="flex items-end gap-1" onsubmit={applyName}>
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">Filter by name</span>
      <Input name="name" value={data.name} placeholder="Cosmetic name…" class="h-8 w-56" />
    </div>
    <Button type="submit" size="sm" variant="outline">Search</Button>
  </form>
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Type</span>
    <MultiCombobox
      options={cosmeticTypeFilters}
      value={data.types}
      onValueChange={applyTypes}
      placeholder="All types…"
    />
  </div>
</div>

{#if data.items.length === 0}
  <div class="placeholder">No cosmetics match this view.</div>
{:else}
  <div class="rounded-xl border">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead class="w-10">
            <Checkbox
              checked={allOnPage}
              indeterminate={someOnPage && !allOnPage}
              onCheckedChange={toggleAllOnPage}
              aria-label="Select all on this page"
            />
          </TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Sample</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.items as cosmetic (cosmetic.id)}
          <TableRow data-state={selectedCosmetics.has(cosmetic.id) ? 'selected' : undefined}>
            <TableCell>
              <Checkbox
                checked={selectedCosmetics.has(cosmetic.id)}
                onCheckedChange={() => toggleCosmetic(cosmetic)}
                aria-label={`Select ${cosmetic.name}`}
              />
            </TableCell>
            <TableCell>
              <div class="flex max-w-sm flex-col">
                <span class="font-medium">{cosmetic.name}</span>
                {#if cosmetic.description}
                  <span class="text-sm text-muted-foreground">{cosmetic.description}</span>
                {/if}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{humanizeCosmeticType(cosmetic.type)}</Badge>
            </TableCell>
            <TableCell>
              <CosmeticSample type={cosmetic.type} name={cosmetic.name} data={cosmetic.data} />
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}

<div class="mt-4 flex flex-wrap items-center justify-between gap-2">
  <span class="text-sm text-muted-foreground">
    {data.totalItems.toLocaleString()} items · page {data.page} of {totalPages}
  </span>
  <Pagination
    count={data.totalItems}
    perPage={data.limit}
    page={data.page}
    onPageChange={(p) => p !== data.page && goto(urlWith({ page: p }))}
  >
    {#snippet children({ pages, currentPage })}
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious />
        </PaginationItem>
        {#each pages as p (p.key)}
          {#if p.type === 'ellipsis'}
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          {:else}
            <PaginationItem>
              <PaginationLink page={p} isActive={currentPage === p.value}>
                {p.value}
              </PaginationLink>
            </PaginationItem>
          {/if}
        {/each}
        <PaginationItem>
          <PaginationNext />
        </PaginationItem>
      </PaginationContent>
    {/snippet}
  </Pagination>
</div>
