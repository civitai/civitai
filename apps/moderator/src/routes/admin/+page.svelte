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

  // Records only what the operator changed, so the default lives in `isOpen` rather than in seeded state.
  // Seeding it from `data` instead would re-seed on every save — collapsing the feature rows someone had
  // just expanded to edit, at the exact moment they are checking their own work.
  let expanded = $state<Record<string, boolean>>({});

  let search = $state('');
  const query = $derived(search.trim().toLowerCase());

  // Matches the label AND the stored key, so "buzz" finds the Buzz capabilities and "/retool" or
  // "capability:" finds everything under that prefix — the key is what you have in hand when you are
  // reading a grant row or an audit entry and want to know what it is.
  const matches = (node: AccessNode) =>
    node.label.toLowerCase().includes(query) || node.key.toLowerCase().includes(query);

  // A node survives if it matches or anything under it does, so a hit on a capability keeps the page and
  // section that give it context rather than stranding a lone row.
  function filterTree(nodes: AccessNode[]): AccessNode[] {
    const out: AccessNode[] = [];
    for (const node of nodes) {
      const children = filterTree(node.children);
      if (children.length || matches(node)) out.push({ ...node, children });
    }
    return out;
  }

  const tree = $derived(query ? filterTree(data.tree) : data.tree);

  const countRows = (nodes: AccessNode[]): number =>
    nodes.reduce((n, node) => n + 1 + countRows(node.children), 0);
  const shown = $derived(countRows(tree));

  // Groups open so the page still reads as the full list at a glance; a page's capabilities stay closed
  // until asked for, which is the drill-down the tree exists to provide. While searching everything is
  // open — a filtered tree whose only hit is collapsed reads as no results at all.
  const isOpen = (node: AccessNode) => (query ? true : expanded[node.key] ?? node.kind === 'group');

  // Every checkbox reads its state from the UNFILTERED node. A filtered node only carries the children
  // that matched, so deriving from it made a page read "checked" while capabilities hidden by the search
  // were ungranted — the filter would have been quietly changing the answer, on a screen whose whole job
  // is to state it.
  function indexTree(nodes: AccessNode[], into = new Map<string, AccessNode>()) {
    for (const node of nodes) {
      into.set(node.key, node);
      indexTree(node.children, into);
    }
    return into;
  }
  const fullByKey = $derived(indexTree(data.tree));
  const full = (node: AccessNode) => fullByKey.get(node.key) ?? node;

  const featureKeysOf = (node: AccessNode) =>
    full(node)
      .children.filter((c) => c.kind === 'feature')
      .map((c) => c.key);

  const pagesUnder = (node: AccessNode): AccessNode[] =>
    node.kind === 'page' ? [node] : full(node).children.flatMap(pagesUnder);

  const has = (key: string, role: string) => (working[key] ?? []).includes(role);

  type TriState = 'on' | 'off' | 'mixed';

  // "Checked means everything under it is checked; a few means mixed" — so a page holding only some of
  // its actions is mixed, not checked, and that mixedness propagates up to the section.
  function pageState(node: AccessNode, role: string): TriState {
    if (!has(node.key, role)) return 'off';
    const features = featureKeysOf(node);
    if (!features.length) return 'on';
    return features.every((f) => has(f, role)) ? 'on' : 'mixed';
  }

  // A group stores nothing of its own; its box reports the pages under it, each of which already folds
  // in its own actions via `pageState`.
  function groupState(node: AccessNode, role: string): TriState {
    const states = pagesUnder(node).map((p) => pageState(p, role));
    if (states.every((s) => s === 'on')) return 'on';
    if (states.every((s) => s === 'off')) return 'off';
    return 'mixed';
  }

  // Always reassigns, even when nothing changed. The Checkbox's `checked`/`indeterminate` are
  // `$bindable` and passed unbound, so a click writes a child-local override that only this
  // reassignment discards; skipping a no-op write would leave the box ticked while the buffer disagrees.
  function setRoles(keys: string[], role: string, on: boolean) {
    const next = { ...working };
    for (const key of keys) {
      const roles = new Set(next[key] ?? []);
      if (on) roles.add(role);
      else roles.delete(role);
      next[key] = [...roles];
    }
    working = next;
  }

  // Both toggles ignore the event's `next`: bits-ui resolves a click on an indeterminate box to `true`,
  // so a mixed row would always grant. The row's own state is the only correct input.
  //
  // Granting adds the page ONLY; revoking removes the page and its actions. That asymmetry is the point.
  // Revoking has to cascade because `canUse` requires the page, so an action left ticked under a page the
  // role cannot open grants nothing while reading on screen as though it did. Granting must NOT cascade,
  // or one click on "User Lookup" hands a volunteer the ability to send Buzz — the exact widening this
  // whole layer exists to prevent. So a mixed row completes by ticking the actions you want, not by
  // clicking the parent.
  const pageKeys = (nodes: AccessNode[], on: boolean) =>
    on ? nodes.map((p) => p.key) : nodes.flatMap((p) => [p.key, ...featureKeysOf(p)]);

  function togglePage(node: AccessNode, role: string) {
    const on = pageState(node, role) === 'off';
    setRoles(pageKeys([node], on), role, on);
  }

  function toggleGroup(node: AccessNode, role: string) {
    const on = groupState(node, role) === 'off';
    setRoles(pageKeys(pagesUnder(node), on), role, on);
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
    working = Object.fromEntries(Object.entries(data.granted).map(([k, r]) => [k, [...r]]));
  }

  const rowId = (key: string, role: string) =>
    `grant-${shortRole(role)}-${key.replace(/[^a-z0-9]+/gi, '-')}`;
</script>

<!-- Every box uses FUNCTION BINDINGS, not plain props. `checked`/`indeterminate` are `$bindable` and the
     primitive writes to them on click; passed one-way, that write is a child-local override Svelte only
     discards when the parent's expression produces a DIFFERENT value than it last pushed. Ticking an
     ungranted page yields `mixed` — `checked` stays false throughout — so the box latched on `true` and
     stuck there, disagreeing with the buffer and with the server, through a Revert. Binding makes this
     component the single source of truth; the setters ignore their argument because the row's own state
     is the only correct input (the primitive resolves a click on an indeterminate box to `true`, which
     would always grant). -->
{#snippet cell(node: AccessNode, role: string)}
  {#if node.kind === 'group'}
    {@const state = groupState(node, role)}
    <!-- Locked while filtering: a section toggle moves every page under it, and under a filter most of
         those are off screen. The state shown is still the true one. -->
    <Checkbox
      id={rowId(node.key, role)}
      aria-label="{node.label} — {shortRole(role)}"
      disabled={!!query}
      title={query ? 'Clear the filter to grant or revoke a whole section.' : undefined}
      bind:checked={() => state === 'on', () => toggleGroup(node, role)}
      bind:indeterminate={() => state === 'mixed', () => {}}
    />
  {:else if node.kind === 'page'}
    {@const state = pageState(node, role)}
    <Checkbox
      id={rowId(node.key, role)}
      aria-label="{node.label} — {shortRole(role)}"
      bind:checked={() => state === 'on', () => togglePage(node, role)}
      bind:indeterminate={() => state === 'mixed', () => {}}
    />
  {:else}
    {@const pageHeld = has(node.parent ?? '', role)}
    <!-- Shows the EFFECTIVE grant, not the stored one. `canUse` requires the page, so a stored feature
         under an ungranted page confers nothing — and rendering it as a tick invites the reader to
         conclude the role has a capability it does not. -->
    <Checkbox
      id={rowId(node.key, role)}
      aria-label="{node.parentLabel}: {node.label} — {shortRole(role)}"
      title={pageHeld
        ? undefined
        : `Grant ${node.parentLabel} to ${shortRole(role)} first — this action needs the page.`}
      disabled={!pageHeld}
      bind:checked={
        () => pageHeld && has(node.key, role),
        () => setRoles([node.key], role, !has(node.key, role))
      }
    />
  {/if}
{/snippet}

{#snippet row(node: AccessNode, depth: number)}
  {@const open = isOpen(node)}
  <!-- `aria-level` is the only thing carrying the hierarchy to a screen reader: depth is an inline
       padding, which is exactly the information the tree was built to add and the one a table row
       otherwise flattens away. -->
  <tr
    class="border-t border-dark-4/60"
    class:bg-dark-6={node.kind === 'group'}
    aria-level={depth + 1}
  >
    <th
      scope="row"
      class="py-1.5 pr-4 text-left font-normal"
      style="padding-left: {depth * 1.25}rem"
    >
      {#if node.children.length}
        <button
          type="button"
          class="flex items-center gap-1 text-left"
          aria-expanded={open}
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
          {#if node.kind === 'page'}
            <span class="text-xs text-dark-2">({full(node).children.length})</span>
          {/if}
        </button>
      {:else}
        <span class="flex items-center gap-1 pl-[1.125rem] text-dark-0">{node.label}</span>
      {/if}
    </th>
    {#each data.roles as role (role)}
      <td class="w-24 py-1.5 text-center">{@render cell(node, role)}</td>
    {/each}
  </tr>
  {#if open}
    {#each node.children as child (child.key)}
      {@render row(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#snippet matrix()}
  <table class="w-full min-w-xl text-sm">
    <caption class="sr-only">Pages and actions each moderator role is granted</caption>
    <thead class="sticky top-0 z-[9] bg-dark-6">
      <tr class="border-b border-dark-4">
        <th scope="col" class="py-2 pl-4 text-left text-xs tracking-wide text-dark-2 uppercase">
          Page
        </th>
        {#each data.roles as role (role)}
          <th scope="col" class="w-24 py-2 text-center text-xs tracking-wide text-blue-4 uppercase">
            {shortRole(role)}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each tree as node (node.key)}
        {@render row(node, 0)}
      {/each}
    </tbody>
  </table>
{/snippet}

<header class="page-header">
  <h1>Permissions</h1>
  <p>
    Each role has its own list of pages — they are independent, so granting a page to one role does
    not grant it to any other. A page a role has not been granted is unreachable for that role.
    Expand a page to grant individual actions inside it; those need the page as well, so revoking the
    page revokes them. A half-filled box means the role holds the page but not every action in it —
    tick the actions you want, since granting a page never grants the actions under it. Roles
    themselves are assigned in the auth hub.
  </p>
  <p class="mt-2 text-dark-2">
    <strong class="font-medium">Admins reach every page and every action regardless of this screen</strong>
    — nothing you change here will alter what your own account sees. To check a change, sign in as an
    account holding only that role, or call
    <code>/api/whoami?userId=…</code>, which reports the verdict for each page and action.
  </p>
</header>

<!-- The outcome sits in the sticky bar beside the button that caused it. At the top of the document it
     scrolls away, and the tree is taller than the viewport — so a refused save looked identical to no
     click at all: the bar still read "N grants changed", with the reason offscreen. -->
<div
  class="sticky top-0 z-10 mb-4 flex items-center gap-3 border-b border-dark-4 bg-background py-3 text-sm"
>
  <span class="flex-1" class:text-red-300={form?.error} class:text-dark-2={!form?.error}>
    {#if form?.error}
      {form.error}
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
  {#if query}
    <span class="text-sm text-dark-2">
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
    {@render matrix()}
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
