<svelte:options customElement={{ tag: 'civitai-training-studio', shadow: 'none' }} />

<script lang="ts">
  import { setHostContext, type StudioLocation } from '$lib/host';
  import { elementBackend, type StudioElementHost } from '$lib/element/backend';
  import StudioApp from '$lib/element/StudioApp.svelte';

  // Both land as JS properties (post-upgrade): `host` carries the credential provider + config;
  // `location` is CONTROLLED by the host — the element renders whichever view it says, and its own
  // navigations go out through host.navigate, which flips `location` back in.
  // Aliased locally: a variable named `host` in scope makes `$host` below parse as a store
  // subscription of the prop (`.subscribe` TypeError at mount) instead of the rune.
  let {
    host: studioHost,
    location = { view: 'home' },
  }: { host?: StudioElementHost; location?: StudioLocation } = $props();

  // Body-level root for portalled UI (dialogs, selects, tooltips). Portalling OUT of the element
  // escapes any ancestor containing block (`container-type` on the embedding page breaks
  // `position: fixed` centering); the build dual-scopes every rule onto `[data-cts-portal]` so the
  // scoped CSS + theme vars still apply there. The HOST toggles `light` on the element, so mirror
  // its class list onto the root.
  const element = $host();
  let portalRoot: HTMLDivElement | undefined;
  $effect(() => {
    const root = document.createElement('div');
    root.setAttribute('data-cts-portal', '');
    const syncTheme = () => root.classList.toggle('light', element.classList.contains('light'));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(element, { attributes: true, attributeFilter: ['class'] });
    document.body.appendChild(root);
    portalRoot = root;
    return () => {
      observer.disconnect();
      root.remove();
      portalRoot = undefined;
    };
  });

  // The host property can land before OR after upgrade; wire the $lib/host seam whenever it
  // (re)appears, and only render once it has — flow components resolve data/hrefs through the seam.
  let ready = $state(false);
  let reloadTick = $state(0);
  $effect(() => {
    if (!studioHost) {
      ready = false;
      return;
    }
    const h = studioHost;
    setHostContext({
      backend: elementBackend(h),
      config: {
        imageLocation: h.config.imageLocation ?? null,
        // No live signals inside the embedded element yet — it runs on polling/reload alone.
        signalsEndpoint: null,
      },
      hrefFor: (loc) => h.hrefFor(loc),
      navigate: (loc, opts) => h.navigate(loc, opts),
      refresh: async () => {
        reloadTick += 1;
      },
      portalTarget: () => portalRoot,
    });
    ready = true;
  });
</script>

{#if !ready}
  <p class="p-6 font-mono text-sm text-dark-2">Waiting for a host context…</p>
{:else}
  <StudioApp {location} {reloadTick} />
{/if}
