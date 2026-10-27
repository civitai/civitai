import Router from 'next/router';

/**
 * Layers that Back closes before it leaves the page. Each open layer owns one history entry at the
 * same URL, marked with the layer's id in `history.state`, so a back swipe pops the top layer instead of
 * navigating, and closing a layer from the UI goes back over its own entry to keep the two in step.
 *
 * Two listeners see a pop: Next's router (through `RoutedDialogProvider`'s `beforePopState`, which
 * must return false for a layer pop or Next re-renders the page) and the listener below, which
 * catches the pops Next never hands to `beforePopState` (its first pop on an unchanged URL, and
 * Safari's null state). Whichever runs first decides; the other reads the same answer.
 */

const LAYER_KEY = '__layer';

type Layer = { id: number; close: () => void };

let layers: Layer[] = [];
/** The page the open layers belong to; a pop to any other URL is a navigation, not a layer. */
let layerPath: string | undefined;
let nextId = 0;
/** Pops we caused ourselves by going back over a layer the UI already closed. */
let ownPops = 0;
let lastPop: { state: unknown; handled: boolean } | undefined;
let listening = false;

const currentPath = () => location.pathname + location.search;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('popstate', (e) => handleHistoryPop(e.state));
  // A navigation leaves the layers' entries behind it; they no longer need going back over.
  Router.events.on('routeChangeStart', () => {
    layers = [];
    layerPath = undefined;
  });
}

/** Opens a layer above the current entry. `close` runs when Back pops it. */
export function openHistoryLayer(close: () => void) {
  listen();
  if (!layers.length) layerPath = currentPath();
  const layer = { id: ++nextId, close };
  layers.push(layer);
  const state = history.state ?? {};
  history.pushState(
    { ...state, [LAYER_KEY]: layer.id, key: `${state.key ?? 'layer'}~${layer.id}` },
    ''
  );
  return layer.id;
}

/** The UI closed a layer: go back over its entry, and over any still open above it. */
export function closeHistoryLayer(id: number) {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index < 0) return;
  const above = layers.slice(index + 1);
  layers = layers.slice(0, index);
  for (const layer of above.reverse()) layer.close();
  if (currentPath() !== layerPath) return;
  ownPops++;
  history.go(-(above.length + 1));
}

/** Handles a pop if it belongs to a layer. True means it was ours and the page must not navigate. */
export function handleHistoryPop(state: unknown): boolean {
  if (state && lastPop?.state === state) return lastPop.handled;
  const handled = applyPop(state);
  if (state) lastPop = { state, handled };
  return handled;
}

function applyPop(state: unknown) {
  if (ownPops > 0) {
    ownPops--;
    return true;
  }
  if (!layers.length) return false;
  if (currentPath() !== layerPath) {
    layers = [];
    return false;
  }
  // Safari can pop with a null state; that is still one step back.
  if (!state) {
    layers.pop()?.close();
    return true;
  }
  // The entry popped to names the layer now on top; every layer above it closes. An entry with no
  // open layer (the page's own, or one left from earlier) closes them all. A newer id than any open
  // is Forward onto a closed layer, which stays closed.
  const id = Number((state as Record<string, unknown>)[LAYER_KEY] ?? 0);
  if (id > layers[layers.length - 1].id) return true;
  const index = layers.findIndex((layer) => layer.id === id);
  while (layers.length > index + 1) layers.pop()?.close();
  return true;
}

export function countHistoryLayers() {
  return layers.length;
}

/** For tests: forget every layer without touching history. */
export function resetHistoryLayers() {
  layers = [];
  layerPath = undefined;
  ownPops = 0;
  lastPop = undefined;
}
