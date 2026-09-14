<script lang="ts">
  import { page } from '$app/state';
  import { FEEDBACK_TABS, feedbackTabHref, type FeedbackTab } from '$lib/feedback-tabs';

  let { active }: { active: FeedbackTab } = $props();
</script>

<!--
  🔴 LINKS, NOT `@civitai/ui`'s `Tabs`, AND THAT IS THE WHOLE DESIGN.

  The no-JS surface on this page is deliberate and load-bearing (see `+page.svelte`'s `pageError`).
  `Tabs` is a bits-ui primitive: its triggers are `<button>`s whose state lives in a Svelte rune, so
  without JS exactly one panel is ever reachable and the Triage form would be unreachable for any
  client that never ran the handler. A link changes the URL, `load` re-runs, and the server renders
  the selected tab — the same behaviour with or without JS.

  🔴 AND `replaceState` IS NOT AN OPTION HERE, verified by reading `@sveltejs/kit@2.66.0`
  (`runtime/client/client.js:2524-2555`): it writes `history` and `page.state`, and leaves `page.url`
  UNTOUCHED — it even stores the OLD `page.url.href` under its own key. So shallow-routing the tab
  would move the address bar and never move the tab, which is the failure that looks like nothing
  happening at all.

  `role="tab"` is deliberately NOT used. The ARIA tab pattern expects roving arrow-key focus over
  controls that swap panels in place; these are ordinary links that navigate. `aria-current` on a
  `<nav>` is the accurate description of what they are, and an accurate one beats an aspirational one.

  The three `data-sveltekit-*` attributes are what make a real navigation behave like a tab switch,
  and they are inert without JS — which is the point:
    - `noscroll`    — without it, selecting a tab scrolls the queue back to the top, away from the
                      row the operator has open.
    - `replacestate`— tab switches are not history the Back button should step through one at a time.
    - `keepfocus`   — a keyboard operator who activated a tab stays on that tab, instead of being
                      dropped back to the top of the document.
-->
<nav aria-label="Report sections" class="-mx-1 overflow-x-auto">
  <ul class="flex w-max min-w-full gap-1 rounded-lg bg-dark-7/60 p-1 text-sm">
    {#each FEEDBACK_TABS as tab (tab.id)}
      <li>
        <a
          href={feedbackTabHref(page.url, tab.id)}
          aria-current={tab.id === active ? 'page' : undefined}
          data-sveltekit-noscroll
          data-sveltekit-replacestate
          data-sveltekit-keepfocus
          class="block rounded-md px-3 py-1.5 whitespace-nowrap transition-colors {tab.id === active
            ? 'bg-dark-5 font-medium text-white'
            : 'text-dark-2 hover:text-white'}"
        >
          {tab.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
