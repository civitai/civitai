<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { dateTime, num } from '$lib/format';
  import { urlWith } from '$lib/url';
  import RuleEditor from './RuleEditor.svelte';
  import type { PageData } from './$types';

  type Rules = NonNullable<PageData['rules']>;

  let {
    rules,
    total,
    query,
    canEdit,
    url,
  }: { rules: Rules; total: number; query: PageData['query']; canEdit: boolean; url: URL } =
    $props();

  let editing = $state<Rules[number] | 'new' | null>(null);

  const STATUSES = [
    ['all', 'All'],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled'],
  ] as const;
</script>

<div class="mb-3 flex flex-wrap items-end gap-3">
  <form method="GET" class="flex items-end gap-2">
    <input type="hidden" name="tab" value="rules" />
    {#if query.status !== 'all'}<input type="hidden" name="status" value={query.status} />{/if}
    <Input
      name="q"
      value={query.q}
      placeholder="Search subject, aliases, description"
      class="w-72"
      aria-label="Search rules"
    />
    <Button type="submit" variant="outline" size="sm">Search</Button>
  </form>

  <div class="flex gap-1">
    {#each STATUSES as [value, label] (value)}
      <a
        href={urlWith(url, { status: value === 'all' ? null : value })}
        class={cn(
          'rounded-md px-3 py-1 text-sm',
          value === query.status ? 'bg-dark-5 text-white' : 'text-dark-2 hover:bg-dark-6'
        )}
      >
        {label}
      </a>
    {/each}
  </div>

  <span class="text-sm text-dark-2">{num(rules.length)} of {num(total)}</span>

  {#if canEdit}
    <Button class="ml-auto" size="sm" onclick={() => (editing = 'new')}>New rule</Button>
  {/if}
</div>

{#if editing}
  {#key editing === 'new' ? 'new' : editing.id}
    <RuleEditor rule={editing === 'new' ? null : editing} onclose={() => (editing = null)} />
  {/key}
{/if}

{#if rules.length === 0}
  <p class="text-sm text-dark-2">No rules match.</p>
{:else}
  <div class="rounded-xl border border-dark-4 bg-dark-6">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Id</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Aliases</TableHead>
          <TableHead>Last edited</TableHead>
          <TableHead class="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each rules as rule (rule.id)}
          <TableRow class={cn(!rule.enabled && 'opacity-60')}>
            <TableCell class="align-top tabular-nums">{rule.id}</TableCell>
            <TableCell class="max-w-56 whitespace-normal align-top">
              <div class="break-words font-medium text-white">{rule.subject}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                  {rule.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                {#if rule.needsAttention}<Badge variant="destructive">Needs attention</Badge>{/if}
                {#if rule.legacy}<Badge variant="outline">Regex</Badge>{/if}
              </div>
              {#if rule.legacyMatch}
                <details class="mt-2 text-xs text-dark-2">
                  <summary class="cursor-pointer">Legacy regex</summary>
                  <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{rule.legacyMatch}</pre>
                </details>
              {/if}
            </TableCell>
            <TableCell class="max-w-72 whitespace-normal align-top text-dark-1">
              <p class="break-words">{rule.description || '—'}</p>
              {#if rule.note}
                <p class="mt-1 break-words text-xs text-dark-2">Note: {rule.note}</p>
              {/if}
            </TableCell>
            <TableCell class="max-w-64 whitespace-normal break-words align-top text-dark-1">
              {rule.aliases.length ? rule.aliases.join(', ') : '—'}
            </TableCell>
            <TableCell class="whitespace-normal align-top text-xs text-dark-2">
              {rule.editedBy ?? (rule.editedById ? `User ${rule.editedById}` : '—')}
              <div>{dateTime(rule.updatedAt)}</div>
            </TableCell>
            <TableCell class="align-top">
              {#if canEdit}
                <div class="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rule.legacy}
                    title={rule.legacy ? 'Convert the regex rules first' : undefined}
                    onclick={() => (editing = rule)}
                  >
                    Edit
                  </Button>
                  <form method="POST" action="?/toggle" use:enhance>
                    <input type="hidden" name="id" value={rule.id} />
                    <input type="hidden" name="enabled" value={String(!rule.enabled)} />
                    <Button type="submit" size="sm" variant="outline">
                      {rule.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </form>
                </div>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}
