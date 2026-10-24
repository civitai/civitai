<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { relativeTime } from '$lib/format';
  import type { LayoutData } from './$types';
  import type { Snippet } from 'svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const activeId = $derived(page.params.chatId ?? null);
  const links = [
    { href: '/assistant/playbooks', label: 'Playbooks' },
    { href: '/assistant/requests', label: 'Tool requests' },
  ];
</script>

<div class="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
  <aside class="min-w-0">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h1 class="m-0 text-lg font-semibold text-white">Mod Assistant</h1>
      <Button size="sm" variant="outline" href="/assistant">New</Button>
    </div>
    <nav class="mb-4 flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {#each links as link (link.href)}
        <a
          href={link.href}
          class={cn(
            'hover:underline',
            page.url.pathname.startsWith(link.href) ? 'text-white' : 'text-dark-2'
          )}
        >
          {link.label}
        </a>
      {/each}
    </nav>

    {#if data.storeError}
      <p class="text-sm text-red-300">{data.storeError}</p>
    {:else if data.chats.length}
      <!-- Foldable: on a phone the list sits above the chat and would otherwise push it off screen. -->
      <details open>
        <summary class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
          Your chats ({data.chats.length})
        </summary>
        <ul class="max-h-48 space-y-1 overflow-y-auto lg:max-h-[60vh]">
          {#each data.chats as chat (chat.id)}
            <li>
              <a
                href="/assistant/{chat.id}"
                aria-current={String(chat.id) === activeId ? 'page' : undefined}
                class={cn(
                  'block rounded-md px-2 py-1.5 text-sm hover:bg-dark-5',
                  String(chat.id) === activeId ? 'bg-dark-5 text-white' : 'text-dark-0'
                )}
              >
                <span class="line-clamp-2">{chat.title}</span>
                <span class="text-xs text-dark-2">{relativeTime(chat.updatedAt)}</span>
              </a>
            </li>
          {/each}
        </ul>
      </details>
    {:else}
      <p class="text-sm text-dark-2">No chats yet.</p>
    {/if}
  </aside>

  <main class="min-w-0">
    <!-- One chat's state (the question being written, a turn in flight) must not carry into the next. -->
    {#key activeId}
      {@render children()}
    {/key}
  </main>
</div>
