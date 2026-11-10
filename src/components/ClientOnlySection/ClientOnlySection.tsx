import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useIsClient } from '~/providers/IsClientProvider';

const ClientOnlySectionsContext = createContext(false);

/**
 * Turns `ClientOnlySection` on for the tree below. A page sets `enabled` from its
 * `ssrClientOnlySections` prop, which its `getServerSideProps` reads from the
 * `ssr-client-only-sections` switch (`~/server/utils/ssr-client-only-sections`). Absent, every
 * section renders as before.
 */
export function ClientOnlySectionsProvider({
  enabled,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ClientOnlySectionsContext.Provider value={!!enabled}>
      {children}
    </ClientOnlySectionsContext.Provider>
  );
}

/**
 * A section the server does not render when `ClientOnlySectionsProvider` is enabled: the server
 * render AND the hydrating render both emit the same empty placeholder (`useIsClient` is false in
 * both, and the switch arrives with the page props), so hydration cannot mismatch; the section
 * mounts on the render after hydration. A client-side navigation or a modal mounts it at once.
 *
 * Only for sections search engines do not need (the page's meta, JSON-LD and main content stay
 * server-rendered) and that sit where their arrival moves nothing above them. `minHeight` is what
 * the placeholder reserves.
 */
export function ClientOnlySection({
  name,
  minHeight,
  className,
  children,
}: {
  /** Names the placeholder (`data-client-only-section`), for tests and for reading a render. */
  name: string;
  minHeight?: number;
  className?: string;
  children: ReactNode;
}) {
  const enabled = useContext(ClientOnlySectionsContext);
  const isClient = useIsClient();
  if (enabled && !isClient)
    return (
      <div
        data-client-only-section={name}
        aria-busy="true"
        className={className}
        style={minHeight ? { minHeight } : undefined}
      />
    );
  return <>{children}</>;
}
