<script lang="ts">
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeImage from './EdgeImage.svelte';
  import { stepLightboxIndex, type LightboxItem } from '$lib/lightbox';

  /**
   * A large view of one image out of a set, with arrow-key paging.
   *
   * 🔴 IT RENDERS `items[i].id` THROUGH `EdgeImage`, so every id reaching it has to be a
   * Cloudflare-images KEY. `getEdgeUrl` returns its argument verbatim when it starts with `http` or
   * `blob`, so a caller that feeds this raw client-supplied text is rendering an arbitrary outbound
   * request in an operator's browser. Callers build `items` from an already-filtered source; on the
   * feedback queue that is `feedbackAttachmentItems(splitContext(row.context))`.
   *
   * `index`/`onIndex` rather than internal state: the open frame is the OWNER'S state, so paging and
   * closing are one decision made in one place, and a caller that re-derives `items` cannot end up
   * pointing at a frame this component still thinks is showing.
   */
  let {
    items,
    index,
    onIndex,
    onClose,
    label = 'Attachment',
  }: {
    items: LightboxItem[];
    /** `null` when closed. Out-of-range is treated as closed rather than throwing. */
    index: number | null;
    onIndex: (next: number) => void;
    onClose: () => void;
    /** Names the dialog for screen readers, e.g. "Attachment". */
    label?: string;
  } = $props();

  const open = $derived(index !== null && index >= 0 && index < items.length);
  const current = $derived(open ? items[index as number] : null);

  /**
   * 🔴 FOCUS RESTORE IS EXPLICIT, and bits-ui's own restore is deliberately PREVENTED rather than
   * relied on. This dialog has no `Dialog.Trigger` — it is opened from whichever thumbnail button was
   * clicked, of which there are several — so there is no single element the library could restore to.
   * Captured on open, used in `onCloseAutoFocus`, and cleared either way so a second open cannot
   * restore to a stale node.
   */
  let restoreTo: HTMLElement | null = null;
  $effect(() => {
    if (open) restoreTo ??= (document.activeElement as HTMLElement | null) ?? null;
  });

  function restoreFocus() {
    const target = restoreTo;
    restoreTo = null;
    // `isConnected`: the panel can be re-rendered under the dialog (a triage save calls
    // `invalidateAll()`), and focusing a detached node silently moves focus to <body> instead.
    if (target?.isConnected) target.focus();
  }

  function close() {
    onClose();
  }

  function page(delta: number) {
    if (index === null || items.length < 2) return;
    onIndex(stepLightboxIndex(index, delta, items.length));
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      page(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      page(-1);
    }
  }
</script>

<!-- Escape is bits-ui's default `escapeKeydownBehavior: 'close'`; it arrives here as `onOpenChange`. -->
<Dialog.Root {open} onOpenChange={(next) => !next && close()}>
  <Dialog.Content
    class="max-h-[90vh] w-[min(92vw,72rem)] max-w-[92vw] overflow-auto sm:max-w-[92vw]"
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      restoreFocus();
    }}
    {onkeydown}
  >
    <Dialog.Header>
      <Dialog.Title class="text-sm font-medium">
        {label}
        {#if items.length > 1 && index !== null}
          <span class="ml-2 font-normal tabular-nums text-dark-2">
            {index + 1} / {items.length}
          </span>
        {/if}
      </Dialog.Title>
      <!-- The caption is the accessible description as well as the visible one: which of the two
           kinds of attachment this is carries different privacy weight, so it must not be
           presentation-only. -->
      <Dialog.Description class="text-xs text-dark-2">
        {current?.caption ?? ''}
      </Dialog.Description>
    </Dialog.Header>

    {#if current}
      <!-- Keyed on the id so paging swaps the element rather than mutating one <img>'s src, which
           would leave the previous frame painted until the next one decodes. -->
      {#key current.id}
        <EdgeImage
          src={current.id}
          width={1600}
          alt={current.caption}
          class="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg"
        />
      {/key}
    {/if}

    {#if items.length > 1}
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" variant="outline" onclick={() => page(-1)}>← Previous</Button>
        <Button size="sm" variant="outline" onclick={() => page(1)}>Next →</Button>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
