import { useRef, type ReactNode } from 'react';
import {
  SignedOutSessionProvider,
  useCivitaiSessionContext,
} from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { Context, createContentSettingsStore } from '~/providers/BrowserSettingsProvider';

/** The content settings store seeded from the session, with no server sync (the real provider needs trpc). */
function SeededSettings({ children }: { children?: ReactNode }) {
  const { settings } = useCivitaiSessionContext();
  const store = useRef<ReturnType<typeof createContentSettingsStore> | null>(null);
  if (!store.current) store.current = createContentSettingsStore({ ...settings, domain: 'green' });
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}

/** A signed-out session with its content settings, which the real UserAvatar reads. */
export function SessionWrapper({ children }: { children?: ReactNode }) {
  return (
    <SignedOutSessionProvider>
      <SeededSettings>{children}</SeededSettings>
    </SignedOutSessionProvider>
  );
}
