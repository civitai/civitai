import { logger } from "../utils/logger";
import { SignalsService } from "../common/services/signals";
import { EntityType } from "../common/types/metric-types";
import { CacheUpdate } from "../types/events";
import { config } from "../config";
import { cacheKeys } from "@/common/utils/cache-keys";
import { signalsMetrics } from "@/metrics";

/**
 * Manages metric signal broadcasting for real-time updates
 */
export class MetricSignals {
  private signalsService: SignalsService;

  constructor() {
    this.signalsService = new SignalsService(
      config.signals?.apiUrl,
      config.signals?.enabled !== false,
    );
  }

  /**
   * Send metric delta matching CacheUpdate interface
   */
  async sendDelta(update: CacheUpdate): Promise<void> {
    if (!this.signalsService.isEnabled()) return;

    // Skip if no actual change
    if (!update.metricValue || update.metricValue === 0) return;
    const topic = cacheKeys.metric(
      update.entityType as EntityType,
      update.entityId,
    );
    try {
      await this.signalsService.sendSignal(topic, "metric:update", {
        entityType: update.entityType,
        entityId: update.entityId,
        // Echo-suppression: the client ignores deltas it originated, since its
        // optimistic update already accounts for them. Only include when known.
        ...(update.userId != null ? { userId: update.userId } : {}),
        [update.metricType]: update.metricValue,
      });
      signalsMetrics.signalsSent.inc();
      logger.debug(
        `Sent delta signal for ${update.entityType}:${update.entityId} - ${update.metricType}: ${update.metricValue}`,
      );
    } catch (err) {
      signalsMetrics.signalsFailed.inc();
      logger.error(
        { err },
        `Failed to send delta signal for ${update.entityType}:${update.entityId}`,
      );
      // Don't throw - signals shouldn't break processing
    }
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      isEnabled: this.signalsService.isEnabled(),
    };
  }
}

// Singleton instance
export const metricSignals = new MetricSignals();
