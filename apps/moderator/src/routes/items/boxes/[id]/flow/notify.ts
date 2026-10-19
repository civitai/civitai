import { toast } from '@civitai/ui/components/ui/sonner/index.js';

/** Top of the screen: the dock owns the bottom, and a toast there covers the buttons. */
export const notify = (message: string) => toast.success(message, { position: 'top-center' });
