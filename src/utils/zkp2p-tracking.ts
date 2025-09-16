type Zkp2pEventType = 'attempt' | 'success' | 'error' | 'abandoned';
type Zkp2pPaymentMethod = 'venmo' | 'cashapp' | 'paypal' | 'zelle' | 'wise' | 'revolut';

interface Zkp2pTrackingData {
  sessionId: string;
  eventType: Zkp2pEventType;
  paymentMethod: Zkp2pPaymentMethod;
  usdAmount: number;
  buzzAmount: number;
  errorMessage?: string;
}

/**
 * Tracks ZKP2P payment events to ClickHouse
 * @param data - The tracking data
 * @param options - Options for tracking
 * @param options.useBeacon - Use navigator.sendBeacon for reliability during page unload
 * @returns Promise that resolves when tracking is complete (or immediately for beacon)
 */
export async function trackZkp2pEvent(
  data: Zkp2pTrackingData,
  options: { useBeacon?: boolean } = {}
): Promise<void> {
  const { useBeacon = false } = options;
  const endpoint = '/api/internal/zkp2p-track';
  const payload = JSON.stringify(data);

  try {
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // Use sendBeacon for page unload scenarios
      navigator.sendBeacon(endpoint, payload);
      return;
    }

    // Use regular fetch for normal tracking
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch (error) {
    console.error(`Failed to track zkp2p ${data.eventType}:`, error);
  }
}

/**
 * Generates a unique session ID for ZKP2P transactions
 */
export function generateZkp2pSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}