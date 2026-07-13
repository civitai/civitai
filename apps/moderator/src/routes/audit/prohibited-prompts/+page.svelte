<script lang="ts">
  import { Tabs, TabsList, TabsTrigger, TabsContent } from '@civitai/ui/components/ui/tabs/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import PromptSegments from '$lib/components/PromptSegments.svelte';
  import { HIGHLIGHT_LEGEND, HIGHLIGHT_MARK } from '$lib/prompt-highlight';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const fmtTime = (iso: string) => {
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
  };
</script>

<header class="page-header">
  <h1>Prohibited Prompts</h1>
  <p class="text-sm text-muted-foreground">
    Today's audit-blocked generation requests, highlighted by what tripped the prompt audit.
  </p>
</header>

<div class="mb-4 flex flex-wrap gap-3">
  {#each HIGHLIGHT_LEGEND as l (l.cat)}
    <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span class="inline-block size-3 rounded {HIGHLIGHT_MARK[l.cat]}"></span>{l.label}
    </span>
  {/each}
</div>

<Tabs value="prompts">
  <TabsList>
    <TabsTrigger value="prompts">Prompts ({data.prompts.length})</TabsTrigger>
    <TabsTrigger value="by-user">By User ({data.userCounts.length})</TabsTrigger>
  </TabsList>

  <TabsContent value="prompts" class="pt-4">
    {#if data.prompts.length === 0}
      <p class="text-sm text-muted-foreground">No prohibited prompts today.</p>
    {:else}
      <div class="flex flex-col gap-3">
        {#each data.prompts as p, i (i)}
          <div class="rounded-lg border p-3">
            <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">User {p.userId}</Badge>
              <Badge variant="outline">{p.source}</Badge>
              <span class="tabular-nums">{fmtTime(p.createdDate)}</span>
            </div>
            <PromptSegments segments={p.promptSegments} />
            {#if p.negativeSegments && p.negativeSegments.length > 0}
              <div class="mt-2 border-t border-border/60 pt-2">
                <span class="text-xs font-semibold uppercase text-muted-foreground">Negative</span>
                <PromptSegments segments={p.negativeSegments} />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </TabsContent>

  <TabsContent value="by-user" class="pt-4">
    {#if data.userCounts.length === 0}
      <p class="text-sm text-muted-foreground">No prohibited prompts today.</p>
    {:else}
      <div class="max-w-md overflow-hidden rounded-lg border">
        <table class="w-full text-sm">
          <thead class="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th class="px-3 py-2 text-left font-medium">User ID</th>
              <th class="px-3 py-2 text-right font-medium">Prohibited prompts</th>
            </tr>
          </thead>
          <tbody>
            {#each data.userCounts as u (u.userId)}
              <tr class="border-t">
                <td class="px-3 py-1.5">{u.userId}</td>
                <td class="px-3 py-1.5 text-right tabular-nums">{u.count}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </TabsContent>
</Tabs>
