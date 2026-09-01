/**
 * Civitai Link has two clients, not one. The ComfyUI node pack gained Link
 * support in civitai/civitai-comfy-nodes#17 (2026-08-27) and pairs with the
 * same key as the desktop app, so onboarding has to offer both.
 */
export type CivitaiLinkConnectPath = 'nodepack' | 'desktop';

export const CIVITAI_LINK_NODE_PACK_NAME = 'Civitai Comfy Nodes';
export const CIVITAI_LINK_NODE_PACK_REPO = 'https://github.com/civitai/civitai-comfy-nodes';
export const CIVITAI_LINK_NODE_PACK_REGISTRY =
  'https://registry.comfy.org/nodes/civitai-comfy-nodes';
export const CIVITAI_LINK_DESKTOP_RELEASES =
  'https://github.com/civitai/civitai-link-desktop/releases/latest';
