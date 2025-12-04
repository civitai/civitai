/**
 * React hook for polling article image scan status
 *
 * Usage:
 *   const { status, isLoading } = useArticleScanStatus({ articleId: 123, enabled: true });
 */

import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

interface UseArticleScanStatusParams {
  articleId: number;
  enabled?: boolean;
  refetchInterval?: number; // milliseconds, default 15000 (15 seconds)
}

export function useArticleScanStatus({
  articleId,
  enabled = true,
  refetchInterval = 15000,
}: UseArticleScanStatusParams) {
  const features = useFeatureFlags();
  const { data, isLoading, error, refetch } = trpc.article.getScanStatus.useQuery(
    { id: articleId },
    {
      enabled: enabled && !!features.articleImageScanning,
      refetchInterval: (data) => {
        // Stop polling when all images are complete
        if (data?.allComplete) return false;
        return refetchInterval;
      },
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
    }
  );

  return {
    status: data,
    isLoading,
    error,
    refetch,
    // Convenience computed properties
    isComplete: data?.allComplete ?? false,
    hasImages: (data?.total ?? 0) > 0,
    progress: data?.total ? ((data.scanned + data.blocked + data.error) / data.total) * 100 : 0,
  };
}
