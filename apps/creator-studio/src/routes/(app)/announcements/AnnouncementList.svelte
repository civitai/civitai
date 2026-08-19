<script lang="ts">
  import { enhance, applyAction } from '$app/forms';
  import type { ActionResult } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { DOMAIN_LABELS, type AnnouncementDomain } from '$lib/announcements';
  import type { AnnouncementRow } from '$lib/server/announcements';

  let {
    announcements,
    error = null,
    onEdit,
  }: {
    announcements: AnnouncementRow[];
    error?: string | null;
    onEdit: (announcement: AnnouncementRow) => void;
  } = $props();

  let confirmingId = $state<number | null>(null);
  let deletingId = $state<number | null>(null);

  const formatDate = (value: Date | string) =>
    new Date(value).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  function status(announcement: AnnouncementRow): string {
    if (announcement.disabled) return 'Hidden';
    const now = Date.now();
    if (announcement.startsAt && new Date(announcement.startsAt).getTime() > now)
      return 'Scheduled';
    if (announcement.endsAt && new Date(announcement.endsAt).getTime() < now) return 'Ended';
    return 'Live';
  }

  const removed = (id: number) => {
    deletingId = id;
    return async ({ result }: { result: ActionResult }) => {
      deletingId = null;
      confirmingId = null;
      await applyAction(result);
    };
  };
</script>

{#if error}
  <p class="text-sm text-red-300">{error}</p>
{/if}

{#if announcements.length === 0}
  <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-dark-2">
    You have not posted any announcements yet.
  </p>
{:else}
  <ul class="flex flex-col gap-3">
    {#each announcements as announcement (announcement.id)}
      <li class="flex gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
        {#if announcement.coverUrl}
          <EdgeImage
            src={announcement.coverUrl}
            width={96}
            alt=""
            class="h-16 w-24 shrink-0 rounded-lg object-cover"
          />
        {/if}
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="truncate font-semibold text-white">{announcement.title}</h3>
            <span class="rounded-full border border-dark-4 px-2 py-0.5 text-xs text-dark-2">
              {status(announcement)}
            </span>
            {#if announcement.profileOnly}
              <span class="rounded-full border border-dark-4 px-2 py-0.5 text-xs text-dark-2">
                Profile only
              </span>
            {/if}
            {#each announcement.domain as domain (domain)}
              <span class="rounded-full border border-dark-4 px-2 py-0.5 text-xs text-dark-2">
                {DOMAIN_LABELS[domain as AnnouncementDomain]?.label ?? domain}
              </span>
            {/each}
          </div>
          <p class="mt-1 line-clamp-2 text-sm text-dark-2">{announcement.content}</p>
          <p class="mt-1 text-xs text-dark-2">
            Posted {formatDate(announcement.createdAt)}
            {#if announcement.endsAt}· ends {formatDate(announcement.endsAt)}{/if}
          </p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-2">
          <Button variant="outline" size="sm" onclick={() => onEdit(announcement)}>Edit</Button>
          {#if confirmingId === announcement.id}
            <form method="POST" action="?/delete" use:enhance={() => removed(announcement.id)}>
              <input type="hidden" name="id" value={announcement.id} />
              <div class="flex gap-2">
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={deletingId === announcement.id}
                >
                  {deletingId === announcement.id ? 'Deleting…' : 'Confirm'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onclick={() => (confirmingId = null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          {:else}
            <Button variant="ghost" size="sm" onclick={() => (confirmingId = announcement.id)}>
              Delete
            </Button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
