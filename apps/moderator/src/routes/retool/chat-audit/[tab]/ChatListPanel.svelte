<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { chatUrl, urlWith } from '../url';
  import type { PageData } from './$types';

  type Search = NonNullable<PageData['search']>;

  let { search, chatId }: { search: Search; chatId: number | null } = $props();

  const MODE_LABEL: Record<Search['mode'], string> = {
    chat: 'chat id',
    user: 'username',
    content: 'message text',
  };

</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">
    Chats ({num(search.chats.length)}{search.truncated ? '+' : ''}) — matched on {MODE_LABEL[
      search.mode
    ]}
  </h3>
  <p class="mb-3 text-xs text-dark-2">
    A number is read as a chat id, a name as a username, anything else as message text. Prefix with
    <code>@</code> to force a username.{#if search.mode === 'content'}
      Message text is searched over the last {search.contentSearchDays} days.{/if}
  </p>

  <!-- A numeric term is a valid chat id AND a valid username, and guessing wrong means showing two
       unrelated people's private conversation. Offer the other reading rather than deciding silently. -->
  {#if search.ambiguousUsername}
    <p class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200">
      <strong>{search.term}</strong> is also a username. This is showing chat {search.term} —
      <a href={urlWith({ q: `@${search.term}`, chat: null, rpage: null })} class={LINK_CLASS}>
        search for the user instead
      </a>.
    </p>
  {/if}

  {#if search.truncated}
    <p class="mb-2 text-xs text-amber-300">
      More than {num(search.chats.length)} chats match — only the most recent are shown.
    </p>
  {/if}

  {#if search.chats.length === 0}
    <p class="text-sm text-dark-2">
      No chats matched.{#if search.mode === 'content'}
        Message text is searched over the last {search.contentSearchDays} days only — an older conversation
        would not appear here.{/if}
    </p>
  {:else}
    <!-- One card per conversation, with the message inside it as a bubble. The card is RAISED off the
         panel (`dark-5` on `dark-6`) and the bubble inset into the card (`dark-7`), so the three levels
         read as panel → conversation → what was said. Selection is a blue ring rather than a fill,
         because the fill it used to use is now the card's own background. -->
    <ul class="space-y-2 text-sm">
      {#each search.chats as chat (chat.chatId)}
        <li
          class="rounded-xl border bg-dark-5 p-3 {chat.chatId === chatId
            ? 'border-blue-5 ring-1 ring-blue-4/70'
            : 'border-dark-4'}"
        >
          <div class="flex flex-wrap items-baseline gap-x-2 text-xs">
            <a href={chatUrl(chat.chatId)} class={LINK_CLASS}>
              chat {chat.chatId}
            </a>
            {#if chat.ownerId}
              <a href={userLookupUrl(chat.ownerId)} class={LINK_CLASS}>
                {chat.owner ?? `#${chat.ownerId}`}
              </a>
            {:else}
              <span class="text-dark-2">no owner</span>
            {/if}
            {#if chat.ownerBannedAt}
              <Badge variant="destructive">owner banned</Badge>
            {/if}
            {#if chat.members.length}
              <span class="line-clamp-1 text-dark-2"
                >with {#each chat.members as m, i (m.userId)}{i > 0
                    ? ', '
                    : ''}<a href={userLookupUrl(m.userId)} class={LINK_CLASS}
                    >{m.username ?? `#${m.userId}`}</a
                  >{/each}</span
              >
            {/if}
            <span class="text-dark-2">
              {num(chat.messages)} messages · last {dateTime(chat.lastAt)}
            </span>
          </div>

          {#if chat.excerpt}
            <div class="mt-1.5">
              <div class="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
                <a href={userLookupUrl(chat.excerpt.userId)} class={LINK_CLASS}>
                  {chat.excerpt.username ?? `#${chat.excerpt.userId}`}
                </a>
                <span class="text-dark-2">{dateTime(chat.excerpt.createdAt)}</span>
                {#if chat.excerpt.matched}<Badge variant="secondary">matched</Badge>{/if}
                {#if chat.excerpt.deleted}<Badge variant="destructive">deleted</Badge>{/if}
              </div>
              <!-- The clamp lives on the inner <p>: `line-clamp` makes its element a `-webkit-box`, and
                   the tail is a child pseudo-element that would then count as a line. -->
              <div
                class="chat-bubble relative rounded-xl border bg-dark-7 px-3 py-2 {chat.excerpt
                  .deleted
                  ? 'border-red-500/40'
                  : 'border-dark-4'}"
              >
                <p class="line-clamp-3 min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">
                  {chat.excerpt.content}
                </p>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  /* The tail: a rotated square straddling the bubble's top edge, showing two of its own borders so it
     reads as part of the outline. `inherit` for both fill and border so the deleted variant's red
     edge carries through without a second rule. */
  .chat-bubble::before {
    content: '';
    position: absolute;
    top: -5px;
    left: 16px;
    height: 9px;
    width: 9px;
    transform: rotate(45deg);
    background: inherit;
    border-top: 1px solid;
    border-left: 1px solid;
    border-color: inherit;
  }
</style>
