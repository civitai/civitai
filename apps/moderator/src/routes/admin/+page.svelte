<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { IconChevronDown, IconChevronRight } from '@tabler/icons-svelte';
  import type { AccessNode } from '$lib/server/access';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const shortRole = (role: string) => role.replace('moderator:', '');

  const baseline = () =>
    Object.fromEntries(Object.entries(data.granted).map(([k, r]) => [k, [...r]]));

  // Seeded at declaration, NOT in the effect alone: `$effect` does not run during SSR, so an empty
  // initialiser server-renders a permissions screen on which every role holds nothing — the worst
  // possible first paint of the one page whose job is to say who can do what.
  let working = $state<Record<string, string[]>>(untrack(baseline));

  // Re-baseline whenever the server sends fresh state — after a save.
  $effect(() => {
    working = baseline();
  });

  // A refusal is otherwise invisible. The default `enhance` does not invalidate on failure, so `data` and
  // `working` are untouched and `dirty` is still non-zero when `form.error` arrives — an `{:else if}`
  // chain led by `dirty` can never reach the error, and a refused save renders identically to no click at
  // all. This says whether the operator has edited since the server last answered, so the refusal shows
  // until they act on it and no longer.
  let editedSinceAnswer = $state(false);
  $effect(() => {
    form;
    untrack(() => (editedSinceAnswer = false));
  });
  const showError = $derived(!!form?.error && !editedSinceAnswer);

  // Records only what the operator changed, so the default lives in `isOpen` rather than in seeded state.
  // Seeding it from `data` instead would re-seed on every save — collapsing the feature rows someone had
  // just expanded to edit, at the exact moment they are checking their own work.
  let expanded = $state<Record<string, boolean>>({});

  let search = $state('');
  const query = $derived(search.trim().toLowerCase());

  // Matches the label AND the stored key, so "buzz" finds the Buzz actions and "/retool" or
  // "grant:" finds everything under that prefix — the key is what you have in hand when you are
  // reading a grant row or an audit entry and want to know what it is.
  const matches = (node: AccessNode) =>
    node.label.toLowerCase().includes(query) || node.key.toLowerCase().includes(query);

  // The filter marks which rows to RENDER; it never rebuilds the tree. Cloning nodes with only their
  // matching children meant every checkbox had to remember to look the real node back up — and the one
  // place that forgot let a page revoke cascade into actions the search was hiding. Here the nodes
  // are always the real ones, so that class of bug cannot be written.
  //
  // A node is visible if it matches, an ancestor matches (so a matched group shows all its pages),
  // or a descendant matches (so a hit keeps the rows that give it context).
  function collectVisible(
    nodes: AccessNode[],
    ancestorMatched: boolean,
    into: Set<string>
  ): boolean {
    let anyVisible = false;
    for (const node of nodes) {
      const self = matches(node);
      const descendant = collectVisible(node.children, ancestorMatched || self, into);
      if (self || descendant || ancestorMatched) {
        into.add(node.key);
        anyVisible = true;
      }
    }
    return anyVisible;
  }

  const visible = $derived.by(() => {
    if (!query) return null;
    const keys = new Set<string>();
    collectVisible(data.tree, false, keys);
    collectVisible(data.actions, false, keys);
    return keys;
  });

  const isVisible = (node: AccessNode) => !visible || visible.has(node.key);
  const childrenOf = (node: AccessNode) => node.children.filter(isVisible);
  /** Rows the filter is showing. `null` while unfiltered — everything is visible then. */
  const shown = $derived(visible?.size ?? null);

  // Groups open so the page still reads as the full list at a glance. While searching everything is
  // open — a filtered tree whose only hit is collapsed reads as no results at all. The stored value is
  // still what gets toggled, so clearing the filter restores what the operator had open.
  const isOpen = (node: AccessNode) => (query ? true : expanded[node.key] ?? node.kind === 'group');

  const pagesUnder = (node: AccessNode): AccessNode[] =>
    node.kind === 'page' ? [node] : node.children.flatMap(pagesUnder);

  const has = (key: string, role: string) => (working[key] ?? []).includes(role);

  type TriState = 'on' | 'off' | 'mixed';

  // A page grants the page and nothing else: actions are their own list, granted separately.
  const pageState = (node: AccessNode, role: string): TriState => (has(node.key, role) ? 'on' : 'off');

  // A group stores nothing of its own; its box reports the pages under it.
  function groupState(node: AccessNode, role: string): TriState {
    const states = pagesUnder(node).map((p) => pageState(p, role));
    // A section with no grantable pages is not "fully granted" — `every` on an empty array says it is.
    if (!states.length) return 'off';
    if (states.every((s) => s === 'on')) return 'on';
    if (states.every((s) => s === 'off')) return 'off';
    return 'mixed';
  }

  function setRoles(keys: string[], role: string, on: boolean) {
    editedSinceAnswer = true;
    const next = { ...working };
    for (const key of keys) {
      const roles = new Set(next[key] ?? []);
      if (on) roles.add(role);
      else roles.delete(role);
      next[key] = [...roles];
    }
    working = next;
  }

  function togglePage(node: AccessNode, role: string) {
    setRoles([node.key], role, pageState(node, role) === 'off');
  }

  function toggleGroup(node: AccessNode, role: string) {
    const on = groupState(node, role) === 'off';
    setRoles(
      pagesUnder(node).map((page) => page.key),
      role,
      on
    );
  }

  const changes = $derived(
    Object.fromEntries(
      Object.entries(working).filter(([key, roles]) => {
        const base: string[] = data.granted[key] ?? [];
        return roles.length !== base.length || roles.some((r) => !base.includes(r));
      })
    )
  );
  const dirty = $derived(Object.keys(changes).length);

  function revert() {
    editedSinceAnswer = true;
    working = Object.fromEntries(Object.entries(data.granted).map(([k, r]) => [k, [...r]]));
  }

  // Used as the checkbox's `id` and by its label association. `:` keeps page paths and capability keys
  // from colliding after the alphanumeric squash.
  const rowId = (key: string, role: string) =>
    `grant:${shortRole(role)}:${key.replace(/[^a-z0-9]+/gi, '-')}`;
</script>

<!-- Function bindings, never one-way props: `checked`/`indeterminate` are `$bindable` and the primitive
     writes to them, so a one-way prop latches whenever a click leaves the parent's value unchanged. The
     setters ignore their argument because the primitive resolves a click on a mixed box to `true`. -->
{#snippet cell(node: AccessNode, role: string)}
  {#if node.kind === 'group'}
    {@const state = groupState(node, role)}
    <!-- Locked while filtering: a section toggle moves every page under it, most of them off screen. -->
    <Checkbox
      id={rowId(node.key, role)}
      aria-label={query
        ? `${node.label} — ${shortRole(role)} (clear the filter to change a whole section)`
        : `${node.label} — ${shortRole(role)}`}
      disabled={!!query}
      bind:checked={() => state === 'on', () => toggleGroup(node, role)}
      bind:indeterminate={() => state === 'mixed', () => {}}
    />
  {:else if node.kind === 'page'}
    {@const state = pageState(node, role)}
    {@const hidden = node.children.length !== childrenOf(node).length}
    <!-- Locked when the filter hides any of its permissions: revoking a page cascades into them, and a
         page whose capability rows are all filtered out renders childless — one click would revoke rows
         nobody can see. -->
    <Checkbox
      id={rowId(node.key, role)}
      aria-label={hidden
        ? `${node.label} — ${shortRole(role)} (clear the filter to change this page)`
        : `${node.label} — ${shortRole(role)}`}
      disabled={hidden}
      bind:checked={() => state === 'on', () => togglePage(node, role)}
      bind:indeterminate={() => state === 'mixed', () => {}}
    />
  {:else}
    <!-- A capability is granted on its own: holding the page it is listed under is not a condition of
         it, so this never disables. Grouping under a page is presentation. -->
    <Checkbox
      id={rowId(node.key, role)}
      aria-label={`${node.label} — ${shortRole(role)}`}
      bind:checked={
        () => has(node.key, role),
        () => setRoles([node.key], role, !has(node.key, role))
      }
    />
  {/if}
{/snippet}

{#snippet row(node: AccessNode, depth: number)}
  {@const open = isOpen(node)}
  <!-- Depth reaches assistive tech through the row header's text, not `aria-level`: that attribute is
       only honoured on rows inside a `treegrid`, so here it announced nothing at all. -->
  <!-- Striped: the row is a long horizontal run of identical boxes, and reading which role a tick
       belongs to means tracking across it. `:nth-child` counts siblings in the tbody, so the banding
       stays correct however deep the tree renders. A group's own shade wins over the stripe. -->
  <tr
    class="border-t border-dark-4/60 hover:bg-dark-7/70 {node.kind === 'group'
      ? 'bg-dark-7'
      : 'odd:bg-dark-7/40'}"
  >
    <th
      scope="row"
      class="py-1.5 pr-4 text-left font-normal"
      style="padding-left: {depth * 1.25}rem"
    >
      {#if node.children.length}
        <button
          type="button"
          class="flex items-center gap-1 text-left disabled:cursor-default"
          aria-expanded={open}
          disabled={!!query}
          onclick={() => (expanded = { ...expanded, [node.key]: !open })}
        >
          {#if open}
            <IconChevronDown size={14} class="shrink-0 text-dark-2" />
          {:else}
            <IconChevronRight size={14} class="shrink-0 text-dark-2" />
          {/if}
          <span
            class={node.kind === 'group'
              ? 'text-xs font-medium tracking-wide text-dark-2 uppercase'
              : 'text-dark-0'}
          >
            {node.label}
          </span>
        </button>
      {:else}
        <span class="flex items-center gap-1 pl-4.5 text-dark-0">{node.label}</span>
      {/if}
    </th>
    {#each data.roles as role (role)}
      <!-- Flex, not `text-center`: the checkbox is a block-level button, which text alignment does not
           move — it sat left of a column header centred over it. -->
      <td class="min-w-24 px-3 py-1.5">
        <div class="flex justify-center">{@render cell(node, role)}</div>
      </td>
    {/each}
  </tr>
  {#if open}
    {#each childrenOf(node) as child (child.key)}
      {@render row(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#snippet matrix(nodes: AccessNode[], heading: string)}
  <table class="w-full min-w-xl text-sm">
    <caption class="sr-only">Pages and actions each moderator role is granted</caption>
    <thead class="sticky top-0 z-10 bg-dark-6">
      <tr class="border-b border-dark-4">
        <th scope="col" class="py-2 pl-4 text-left text-xs tracking-wide text-dark-2 uppercase">
          {heading}
        </th>
        <!-- Sized by content, never a fixed width: role names come from the hub at whatever length
             someone gave them, and the panel already scrolls horizontally. -->
        {#each data.roles as role (role)}
          <th
            scope="col"
            class="min-w-24 px-3 py-2 text-center text-xs tracking-wide whitespace-nowrap text-dark-2 uppercase"
          >
            {shortRole(role)}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each nodes.filter(isVisible) as node (node.key)}
        {@render row(node, 0)}
      {/each}
    </tbody>
  </table>
{/snippet}

<header class="page-header">
  <h1>Permissions</h1>
  <p>
    Two independent kinds of grant. <strong class="font-medium">Page grants</strong> decide what a role
    may OPEN — a page a role has not been granted is unreachable for it.
    <strong class="font-medium">Action grants</strong>, in the second table, decide what a role may DO,
    and are granted on their own: an action is not tied to a page, and granting or revoking a page never
    changes one. Each role's grants are its own, so granting to one role grants to no other. Roles
    themselves are created and assigned in the auth hub — a new one appears here as a column with
    nothing granted, and holds nothing until you tick it.
  </p>
  <p class="mt-2 text-dark-2">
    <strong class="font-medium">Admins reach every page and every action regardless of this screen</strong>
    — nothing you change here will alter what your own account sees. To check a change, sign in as an
    account holding only that role, or call
    <code>/api/whoami?userId=…</code>, which reports the verdict for each page and action.
  </p>
</header>

<!-- The outcome sits beside the button that caused it: the tree is taller than the viewport, so at the
     top of the document a refused save scrolled out of sight and read as no click at all. A refusal
     outranks the dirty count and states that the changes are still here, because a refused save leaves
     `dirty` exactly as it was — showing only the count is what made the refusal invisible. -->
<div
  class="sticky top-0 z-10 mb-4 flex items-center gap-3 border-b border-dark-4 bg-background py-3 text-sm"
>
  <span
    role="status"
    class="flex-1"
    class:text-red-300={showError}
    class:text-dark-2={!showError}
  >
    {#if showError}
      {form?.error}{dirty
        ? ` Your ${dirty} unsaved change${dirty === 1 ? '' : 's'} ${dirty === 1 ? 'is' : 'are'} still on screen.`
        : ''}
    {:else if dirty}
      {dirty} grant{dirty === 1 ? '' : 's'} changed — not saved yet.
    {:else if form?.count}
      Saved {form.count} grant{form.count === 1 ? '' : 's'}. Applies within 30 seconds across all
      servers.
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

<div class="mb-3 flex flex-wrap items-center gap-3">
  <Input
    type="search"
    bind:value={search}
    placeholder="Filter by page or action — try “buzz”"
    aria-label="Filter pages and actions"
    class="w-full sm:w-96"
  />
  {#if query && shown !== null}
    <span class="text-sm text-dark-2" aria-live="polite">
      {shown} row{shown === 1 ? '' : 's'}
    </span>
    <Button variant="outline" size="sm" onclick={() => (search = '')}>Clear</Button>
  {/if}
</div>

<!-- The matrix scrolls in its own panel rather than with the page, so the role columns can stay pinned:
     `overflow-x-auto` already makes this element a scroll container (setting one axis to `auto` computes
     the other to `auto` too), which would clip a header sticking to the page's scroller. The tree runs
     several viewports, and without pinned columns every checkbox below the fold is an unlabelled box in
     a row of three. -->
<div class="max-h-[calc(100vh-14rem)] overflow-auto rounded-xl border border-dark-4 bg-dark-6">
  {#if shown === 0}
    <p class="p-5 text-sm text-dark-2">
      Nothing matches <span class="text-dark-0">{search}</span>. Filtering searches page and action
      names as well as their stored keys.
    </p>
  {:else}
    {@render matrix(data.tree, 'Page')}
  {/if}
</div>

<!-- Actions are their own list, not rows under a page. A permission is granted on its own: holding the
     page an action is used from is not a condition of holding the action, and one action can be reached
     from more than one page. -->
<h2 class="mt-6 mb-2 text-sm font-semibold text-white">Action grants</h2>
<p class="mb-3 text-sm text-dark-2">
  What a role may DO, granted independently of the pages it may open. An action still needs a page to
  reach it, so a role holding an action but not the page that uses it holds something inert — that is a
  grant to review, not something this screen prevents.
</p>
<div class="max-h-[60vh] overflow-auto rounded-xl border border-dark-4 bg-dark-6">
  {#if data.actions.filter(isVisible).length === 0}
    <p class="p-5 text-sm text-dark-2">No actions match <span class="text-dark-0">{search}</span>.</p>
  {:else}
    {@render matrix(data.actions, 'Action')}
  {/if}
</div>

<!-- Edits survive filtering: `working` holds every key, and the filter only narrows what is rendered.
     A grant changed under one search term is still in the change set under another, and Save writes
     all of them. -->
{#if dirty && query}
  <p class="mt-2 text-xs text-dark-2">
    {dirty} unsaved change{dirty === 1 ? '' : 's'} — including any made outside the current filter.
  </p>
{/if}
