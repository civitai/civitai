import type { LayoutServerLoad } from './$types';
import { toolCatalog } from '$lib/server/assistant/tools';

// Both playbook forms list the lookups beside the editor. Static, so it loads even when the store is down.
export const load: LayoutServerLoad = () => ({ tools: toolCatalog() });
