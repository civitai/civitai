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

<!--
  Escape is bits-ui's default `escapeKeydownBehavior: 'close'`, and it arrives here as a write to
  `open` — same path as a click on the overlay or the close button.

  🔴 A FUNCTION BINDING, NOT A PLAIN `open={…}` PROP, for the reason `FeedbackFilters.svelte` already
  records about this primitive family: bits-ui declares `open` as `$bindable` and WRITES to it on
  interaction (`bits-ui@2.18.1`, `dialog/components/dialog.svelte`). Handed a plain prop, that write
  lands in a child-local override which Svelte only discards when the parent yields a DIFFERENT
  value — so any close the parent does not observe leaves `openIndex` set against a dialog that is
  already closed, and re-clicking the SAME thumbnail then does nothing. The getter makes the parent
  the only source of truth; the setter is the one place a close is turned into state.
-->
<Dialog.Root
  bind:open={() => open,
  (next) => {
    if (!next) close();
  }}
>
  <!--
    🔴 FOCUS RESTORE IS THE LIBRARY'S, AND THIS COMPONENT DELIBERATELY DOES NOT HAND-ROLL IT. An
    earlier draft here `preventDefault`ed `onCloseAutoFocus` and restored focus itself, on the
    premise that a dialog with no `Dialog.Trigger` gives the library nothing to restore to. THAT
    PREMISE IS FALSE, and reading the source is what settled it: `focus-scope-manager.js:14-26`
    captures `document.activeElement` at `register()` — which `mount()` calls BEFORE
    `#handleOpenAutoFocus` — and `focus-scope.svelte.js:72-90` focuses it again on unmount, guarded by
    `document.contains` and a `try/catch`. No trigger is involved; whatever had focus when the scope
    opened is what gets it back, which is exactly the thumbnail button that was clicked.

    So the trap to avoid is re-adding a manual restore: a hand-rolled capture races the library's own
    (its `focusFirst` runs in a `requestAnimationFrame`), and preventing the library's restore to run
    your own replaces a guarded implementation with an unguarded one.

    The one case worth knowing: if the panel is re-rendered underneath (a triage save calls
    `invalidateAll()`) the thumbnail node can be detached, and `document.contains` then declines to
    focus it rather than throwing. Focus falls to the body — degraded, not broken.
  -->
  <Dialog.Content
    class="max-h-[90vh] w-[min(92vw,72rem)] max-w-[92vw] overflow-auto sm:max-w-[92vw]"
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
      <!-- Keyed on the INDEX, not on `current.id`, so paging swaps the element rather than mutating
           one <img>'s src — which would leave the previous frame painted until the next decodes.
           Index rather than id because ids are NOT unique here: `splitContext` deduplicates `images`
           among themselves and never compares `screenshotId` against them, so a reporter who
           attached the same file the capture produced yields two frames sharing an id, and keying on
           it would make paging between exactly those two a no-op. -->
      {#key index}
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
