<script lang="ts">
  import { enhance, applyAction } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ActionResult } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import {
    IconCalendar,
    IconCalendarOff,
    IconEye,
    IconPencil,
    IconPointer,
    IconTrash,
  } from '@tabler/icons-svelte';
  import { DOMAIN_LABELS, type AnnouncementDomain } from '$lib/announcements';
  import type { AnnouncementRow } from '$lib/server/announcements';
  import type { AnnouncementMetrics } from '$lib/server/announcement-analytics';

  let {
    announcements,
    metrics,
    deleteError = null,
    onEdit,
  }: {
    announcements: AnnouncementRow[];
    /** Null when the metrics read failed — rows then say so rather than showing a zero. */
    metrics: AnnouncementMetrics | null;
    /** Carries the row it belongs to, so a failure renders beside that row and nowhere else. */
    deleteError?: { id: number | null; message: string } | null;
    onEdit: (announcement: AnnouncementRow) => void;
  } = $props();

  let confirmingId = $state<number | null>(null);
  let deletingId = $state<number | null>(null);

  const seen = (id: number) => metrics?.impressions[id] ?? 0;
  const clicked = (id: number) => metrics?.clicks[id] ?? 0;

  const num = (value: number) => value.toLocaleString();

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
      // A custom callback replaces the default one, which invalidates before it applies — without
      // this the deleted row stays on screen and reads as a silent failure. The confirmation stays
      // open on failure, which is where the error for that row renders.
      if (result.type === 'success') {
        confirmingId = null;
        await invalidateAll();
      }
      await applyAction(result);
    };
  };
</script>

{#if deleteError && !announcements.some((a) => a.id === deleteError?.id)}
  <p class="text-sm text-red-300">{deleteError.message}</p>
{/if}

{#if announcements.length === 0}
  <p class="cs-panel p-5 text-sm text-dark-2">You have not posted any announcements yet.</p>
{:else}
  <ul class="flex flex-col gap-3">
    {#each announcements as announcement (announcement.id)}
      <li class="cs-panel flex gap-4 p-5">
        {#if announcement.coverUrl}
          <EdgeImage
            src={announcement.coverUrl}
            width={96}
            alt=""
            class="size-16 shrink-0 rounded-lg object-cover"
          />
        {/if}
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            {#if announcement.title}
              <h3 class="truncate font-semibold text-white">{announcement.title}</h3>
            {/if}
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
          <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dark-2">
            <span class="flex items-center gap-1">
              <IconCalendar size={14} class="shrink-0" />
              Posted {formatDate(announcement.createdAt)}
            </span>
            {#if announcement.endsAt}
              <span class="flex items-center gap-1">
                <IconCalendarOff size={14} class="shrink-0" />
                Ends {formatDate(announcement.endsAt)}
              </span>
            {/if}
            {#if metrics}
              {@const impressions = seen(announcement.id)}
              {@const clicks = clicked(announcement.id)}
              <span class="flex items-center gap-1" title="People who saw this announcement">
                <IconEye size={14} class="shrink-0" />
                <span class="font-medium text-white">{num(impressions)}</span> Seen
              </span>
              {#if announcement.link}
                <span class="flex items-center gap-1" title="Clicks on this announcement's link">
                  <IconPointer size={14} class="shrink-0" />
                  <span class="font-medium text-white">{num(clicks)}</span>
                  {clicks === 1 ? 'Click' : 'Clicks'}
                </span>
              {/if}
            {/if}
          </div>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-2">
          {#if confirmingId !== announcement.id}
            <div class="flex gap-1">
              <Button variant="ghost" size="sm" onclick={() => onEdit(announcement)}>
                <IconPencil size={15} class="mr-1" /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-red-300 hover:text-red-200"
                onclick={() => (confirmingId = announcement.id)}
              >
                <IconTrash size={15} class="mr-1" /> Delete
              </Button>
            </div>
          {/if}
          {#if confirmingId === announcement.id}
            <form method="POST" action="?/delete" use:enhance={() => removed(announcement.id)}>
              <input type="hidden" name="id" value={announcement.id} />
              {#if deleteError?.id === announcement.id}
                <p class="mb-2 max-w-48 text-right text-sm text-red-300">{deleteError.message}</p>
                <!-- Keyed on the spend ledger, not on `profileOnly`: an announcement that notified
                     and was later switched to profile-only still consumed its broadcast. -->
              {:else if announcement.spentSlot}
                <p class="mb-2 max-w-48 text-right text-xs text-dark-2">
                  Deleting does not return the broadcast it used.
                </p>
              {/if}
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
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
