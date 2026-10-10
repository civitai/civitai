<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { IconPlus, IconX } from '@tabler/icons-svelte';
  import {
    LINK_BUTTONS_MAX,
    LINK_SLOTS,
    LINK_TEXT_MAX,
    type AnnouncementLink,
  } from '$lib/announcements';

  let { seed, isMember }: { seed: AnnouncementLink[]; isMember: boolean } = $props();

  // A stable id per row: keyed by position, removing row 2 would leave focus on what was row 3.
  let nextLinkId = 0;
  const newLink = (url = '', text = '') => ({ id: nextLinkId++, url, text });

  const initial = untrack(() => seed);
  let links = $state(
    initial.length ? initial.map((l) => newLink(l.link, l.linkText)) : [newLink()]
  );
  // A lapsed member may save as many buttons as the row already had (the main app's grandfather
  // rule), so removing one and putting it back is allowed; going past that is not.
  const canAddLink = $derived(
    links.length < LINK_BUTTONS_MAX && (isMember || links.length < initial.length)
  );

  function addLink() {
    links.push(newLink());
  }

  function removeLink(index: number) {
    links.splice(index, 1);
  }

  // Shows the creator the adaptation the server performs on save: a link to one of our own
  // domains is stored as a path so it opens on whichever site the reader is on. This is the
  // visible half only — `toDomainRelativeLink` on the server is what actually decides, and
  // it reads the real host list from server env, which the browser has no business knowing.
  const OWN_HOSTS = ['civitai.com', 'civitai.red', 'civitaired.com'];

  function truncateOwnDomain(index: number) {
    const value = links[index].url.trim();
    if (!value) return;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return; // already a path
    }

    const host = url.host.toLowerCase();
    const ours = OWN_HOSTS.includes(host) || host === window.location.host.toLowerCase();
    if (!ours) return;

    links[index].url = `${url.pathname}${url.search}${url.hash}` || '/';
  }
</script>

<div class="flex flex-col gap-3">
  {#each links as link, index (link.id)}
    {@const [urlName, textName] = LINK_SLOTS[index]}
    <div class="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]">
      <div class="flex flex-col gap-1.5">
        <Label for={`announcement-${urlName}`}>
          {index === 0 ? 'Button link (optional)' : `Button ${index + 1} link`}
        </Label>
        <Input
          id={`announcement-${urlName}`}
          name={urlName}
          bind:value={link.url}
          onblur={() => truncateOwnDomain(index)}
          placeholder="/models/123 or https://…"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for={`announcement-${textName}`}>
          {index === 0 ? 'Button text' : `Button ${index + 1} text`}
        </Label>
        <Input
          id={`announcement-${textName}`}
          name={textName}
          bind:value={link.text}
          maxlength={LINK_TEXT_MAX}
          placeholder="Check it out"
        />
      </div>
      {#if links.length > 1}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove button ${index + 1}`}
          onclick={() => removeLink(index)}
        >
          <IconX size={16} />
        </Button>
      {/if}
    </div>
  {/each}
  {#if canAddLink}
    <Button type="button" variant="outline" size="sm" class="self-start" onclick={addLink}>
      <IconPlus size={15} class="mr-1" /> Add button
    </Button>
  {:else if !isMember && links.length < LINK_BUTTONS_MAX}
    <p class="text-xs text-dark-2">
      Members can add up to {LINK_BUTTONS_MAX} buttons to an announcement.
    </p>
  {/if}
</div>
