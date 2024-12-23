import UserErrorBoundary from '~/components/ErrorBoundary/UserErrorBoundary';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const features = useFeatureFlags();

  return <UserErrorBoundary features={features}>{children}</UserErrorBoundary>;
}
