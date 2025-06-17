import type { KontextAdOptions, KontextAdParams } from '~/components/Ads/Kontext/kontext-ads.types';

declare global {
  interface Window {
    fetchKontextAd: (params: KontextAdParams, options?: KontextAdOptions) => void;
    markKontextAdAsViewed: (impressionId: string, serverUrl?: string) => void;
  }
}
