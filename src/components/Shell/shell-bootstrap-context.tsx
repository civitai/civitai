import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

/**
 * The shell boot's status context and its readiness hook, kept apart from
 * `ShellBootstrapProvider.tsx` (which re-exports them) so a reader of readiness alone, such as
 * `FaroProvider`, does not import the boot's tRPC and router machinery.
 */

export type ShellStatus = 'pending' | 'ready' | 'failed';

export const ShellBootstrapContext = createContext<{ status: ShellStatus } | null>(null);

/** Mounted by `_app` only for an app that booted on a shell page. */
export function ShellBootstrapProvider({
  status,
  children,
}: {
  status: ShellStatus;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ status }), [status]);
  return <ShellBootstrapContext.Provider value={value}>{children}</ShellBootstrapContext.Provider>;
}

/** False only while a shell boot is still waiting for (or failed to get) its page data. */
export function useShellReady() {
  const context = useContext(ShellBootstrapContext);
  return !context || context.status === 'ready';
}
