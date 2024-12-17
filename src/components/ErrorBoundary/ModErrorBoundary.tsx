import ErrorBoundary from '~/components/ErrorBoundary/ErrorBoundary';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ModErrorBoundary({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();

  return currentUser?.isModerator ? <ErrorBoundary>{children}</ErrorBoundary> : <>{children}</>;
}
