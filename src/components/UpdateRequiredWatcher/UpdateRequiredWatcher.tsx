import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const UpdateRequiredModal = dynamic(
  () => import('~/components/UpdateRequiredWatcher/UpdateRequiredModal')
);

let warned = false;
let originalFetch: typeof window.fetch | undefined;
export function UpdateRequiredWatcher({ children }: { children: React.ReactElement }) {
  // TODO - someday, this kind of logic should probably be stored in an error boundary
  useEffect(() => {
    if (originalFetch || typeof window === 'undefined') return;
    originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch!(...args);
      if (response.headers.has('x-update-required') && !warned) {
        dialogStore.trigger({
          id: 'update-required-modal',
          component: UpdateRequiredModal,
        });
        warned = true;
      }
      return response;
    };
  }, []);

  return children;
}
