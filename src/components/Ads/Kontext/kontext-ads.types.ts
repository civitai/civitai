export type KontextAdParams = {
  publisherToken: string;
  code: string;
  userId: string;
  conversationId: string;
  logLevel?: 'debug' | 'info' | 'log' | 'warn' | 'error' | 'silent';
  messages: KontextMessage[];
  element: HTMLElement;
};

type KontextMessage = {
  id: string;
  createdAt: Date;
  role: 'user' | 'assistant';
  content: string;
};

export type KontextAdOptions = {
  onStart?: () => void /* Called just before the ad server request */;
  onComplete?: (content: any, metadata: any) => void /* Called when ad is completely streamed */;
  onToken?: (value: string) => void /* Called after each token is received */;
  onError?: (error: any) => void /* Called when streaming encounters an error */;
  onAdClick?: (impression: {
    id: string;
    content: string;
  }) => void /* Called when ad is clicked (for your analytics) */;
  onAdView?: (impression: {
    id: string;
    content: string;
  }) => void /* Called when ad is viewed (for your analytics) */;
  onBid?: (
    value: number | null
  ) => Promise<boolean> /* Called when an ad is available to fill your ad slot along with the bid value for the ad. Return true if you want to render the ad. */;
};
