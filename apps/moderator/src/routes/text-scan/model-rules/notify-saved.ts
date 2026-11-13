import { toast } from '@civitai/ui/components/ui/sonner/index.js';

/** The toasts for a rule write's action result: its message, and a warning when the cache stayed stale. */
export function notifySaved(data: Record<string, unknown> | undefined) {
  toast.success(String(data?.message ?? 'Saved'));
  if (data?.cacheWarning) toast.warning(String(data.cacheWarning));
}
