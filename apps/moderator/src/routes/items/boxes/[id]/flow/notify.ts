import { toast } from '@civitai/ui/components/ui/sonner/index.js';

/** Top-center: the dock owns the bottom and a toast there covers its buttons. */
export const notify = (message: string) => toast.success(message, { position: 'top-center' });
