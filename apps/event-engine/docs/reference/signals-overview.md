# Real-Time Image Metrics via Signals

## Overview

This document describes how to implement real-time metric updates for images using the Civitai Signals service. The system uses SignalR WebSockets with topic-based subscriptions to efficiently deliver metric deltas to clients viewing specific images.

**Note:** The Signals API is only accessible within the internal network and does not require authentication for backend API calls.

## Environment Variables

Configure these environment variables for your service that will send signals:

```env
# Required (internal network only)
SIGNALS_API_URL=http://signals-service.internal  # Internal service URL

# Optional (for development)
SIGNALS_API_URL=http://localhost:5000  # Local development server
```

## Architecture Flow

1. **Client** subscribes to metrics for visible images via SignalR
2. **Metric Service** detects changes and sends deltas via HTTP POST to Signals API
3. **Signals API** broadcasts to all subscribers of that image's topic
4. **Client** receives real-time updates and updates UI

## Client Implementation (TypeScript)

### 1. Setup SignalR Connection

```typescript
import * as signalR from "@microsoft/signalr";

interface MetricUpdate {
    imageId: string;
    metrics: {
        views?: { delta: number; total: number };
        likes?: { delta: number; total: number };
        downloads?: { delta: number; total: number };
        generations?: { delta: number; total: number };
    };
    timestamp: number;
}

class ImageMetricsClient {
    private connection: signalR.HubConnection;
    private subscribedImages: Set<string> = new Set();
    private userId: number;

    constructor(userId: number) {
        this.userId = userId;
    }

    async initialize() {
        // Get access token
        const tokenResponse = await fetch(`/users/${this.userId}/accessToken`);
        const { accessToken } = await tokenResponse.json();

        // Create SignalR connection
        this.connection = new signalR.HubConnectionBuilder()
            .withUrl("/hub", {
                accessTokenFactory: () => accessToken
            })
            .withAutomaticReconnect()
            .configureLogging(signalR.LogLevel.Information)
            .build();

        // Setup metric update handler
        this.connection.on("metrics:update", (update: MetricUpdate) => {
            this.handleMetricUpdate(update);
        });

        // Start connection
        await this.connection.start();
        console.log("Connected to Signals hub");
    }

    private handleMetricUpdate(update: MetricUpdate) {
        // Dispatch to your UI update logic
        console.log(`Metrics updated for image ${update.imageId}:`, update.metrics);

        // Example: Update React state, Redux store, or DOM
        document.dispatchEvent(new CustomEvent('image-metrics-update', {
            detail: update
        }));
    }
}
```

### 2. Subscribe to Image Metrics

```typescript
class ImageMetricsClient {
    // ... previous code ...

    async subscribeToImage(imageId: string) {
        if (this.subscribedImages.has(imageId)) {
            return; // Already subscribed
        }

        try {
            const topic = `image:${imageId}:metrics`;
            await this.connection.invoke("Subscribe", topic);
            this.subscribedImages.add(imageId);
            console.log(`Subscribed to metrics for image ${imageId}`);
        } catch (error) {
            console.error(`Failed to subscribe to image ${imageId}:`, error);
        }
    }

    async unsubscribeFromImage(imageId: string) {
        if (!this.subscribedImages.has(imageId)) {
            return; // Not subscribed
        }

        try {
            const topic = `image:${imageId}:metrics`;
            await this.connection.invoke("Unsubscribe", topic);
            this.subscribedImages.delete(imageId);
            console.log(`Unsubscribed from metrics for image ${imageId}`);
        } catch (error) {
            console.error(`Failed to unsubscribe from image ${imageId}:`, error);
        }
    }

    // Batch operations for performance
    async subscribeToImages(imageIds: string[]) {
        const promises = imageIds.map(id => this.subscribeToImage(id));
        await Promise.all(promises);
    }

    async unsubscribeFromImages(imageIds: string[]) {
        const promises = imageIds.map(id => this.unsubscribeFromImage(id));
        await Promise.all(promises);
    }

    // Clean up on disconnect
    async disconnect() {
        await this.connection.stop();
        this.subscribedImages.clear();
    }
}
```

### 3. Intersection Observer for Viewport Tracking

```typescript
class ImageViewportTracker {
    private observer: IntersectionObserver;
    private metricsClient: ImageMetricsClient;

    constructor(metricsClient: ImageMetricsClient) {
        this.metricsClient = metricsClient;

        // Create observer with reasonable thresholds
        this.observer = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            {
                root: null, // viewport
                rootMargin: '50px', // Start loading slightly before visible
                threshold: 0.01 // Trigger when 1% visible
            }
        );
    }

    private async handleIntersection(entries: IntersectionObserverEntry[]) {
        for (const entry of entries) {
            const imageElement = entry.target as HTMLElement;
            const imageId = imageElement.dataset.imageId;

            if (!imageId) continue;

            if (entry.isIntersecting) {
                // Image entered viewport
                await this.metricsClient.subscribeToImage(imageId);
            } else {
                // Image left viewport
                await this.metricsClient.unsubscribeFromImage(imageId);
            }
        }
    }

    observe(imageElement: HTMLElement) {
        if (!imageElement.dataset.imageId) {
            console.warn('Image element missing data-image-id attribute');
            return;
        }
        this.observer.observe(imageElement);
    }

    unobserve(imageElement: HTMLElement) {
        this.observer.unobserve(imageElement);
    }

    disconnect() {
        this.observer.disconnect();
    }
}

// Usage
const metricsClient = new ImageMetricsClient(userId);
await metricsClient.initialize();

const tracker = new ImageViewportTracker(metricsClient);

// Observe all images on the page
document.querySelectorAll('[data-image-id]').forEach(img => {
    tracker.observe(img as HTMLElement);
});
```

## Backend Implementation (Metric Service)

### 1. Send Metric Updates (TypeScript/Node.js)

```typescript
interface MetricDelta {
    imageId: string;
    metrics: {
        views?: { delta: number; total: number };
        likes?: { delta: number; total: number };
        downloads?: { delta: number; total: number };
        generations?: { delta: number; total: number };
    };
}

class MetricSignalService {
    private signalsApiUrl: string;

    constructor() {
        this.signalsApiUrl = process.env.SIGNALS_API_URL || 'http://localhost:5000';
    }

    async sendMetricUpdate(imageId: string, metrics: MetricDelta['metrics']) {
        const topic = `image:${imageId}:metrics`;
        const url = `${this.signalsApiUrl}/topics/${encodeURIComponent(topic)}/signals/metrics:update`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    imageId,
                    metrics,
                    timestamp: Date.now()
                })
            });

            if (!response.ok) {
                throw new Error(`Signal API returned ${response.status}`);
            }

            console.log(`Metric update sent for image ${imageId}`);
        } catch (error) {
            console.error(`Failed to send metric update for image ${imageId}:`, error);
            // Implement retry logic or queue for later
        }
    }

    // Batch updates for efficiency
    async sendBatchMetricUpdates(updates: MetricDelta[]) {
        const promises = updates.map(update =>
            this.sendMetricUpdate(update.imageId, update.metrics)
        );

        const results = await Promise.allSettled(promises);

        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            console.error(`${failed.length} metric updates failed`);
        }
    }
}
```

### 2. Example: Metric Change Detection Service

```typescript
class MetricChangeDetector {
    private signalService: MetricSignalService;
    private lastMetrics: Map<string, any> = new Map();

    constructor() {
        this.signalService = new MetricSignalService();
    }

    async processMetricChange(imageId: string, newMetrics: any) {
        const lastMetric = this.lastMetrics.get(imageId) || {
            views: 0,
            likes: 0,
            downloads: 0,
            generations: 0
        };

        const delta: any = {
            imageId,
            metrics: {}
        };

        // Calculate deltas
        if (newMetrics.views !== lastMetric.views) {
            delta.metrics.views = {
                delta: newMetrics.views - lastMetric.views,
                total: newMetrics.views
            };
        }

        if (newMetrics.likes !== lastMetric.likes) {
            delta.metrics.likes = {
                delta: newMetrics.likes - lastMetric.likes,
                total: newMetrics.likes
            };
        }

        if (newMetrics.downloads !== lastMetric.downloads) {
            delta.metrics.downloads = {
                delta: newMetrics.downloads - lastMetric.downloads,
                total: newMetrics.downloads
            };
        }

        if (newMetrics.generations !== lastMetric.generations) {
            delta.metrics.generations = {
                delta: newMetrics.generations - lastMetric.generations,
                total: newMetrics.generations
            };
        }

        // Only send if there are changes
        if (Object.keys(delta.metrics).length > 0) {
            await this.signalService.sendMetricUpdate(imageId, delta.metrics);
            this.lastMetrics.set(imageId, newMetrics);
        }
    }
}
```

## React Integration Example

```tsx
import React, { useEffect, useState } from 'react';

interface ImageWithMetricsProps {
    imageId: string;
    src: string;
    initialMetrics?: {
        views: number;
        likes: number;
        downloads: number;
    };
}

export function ImageWithMetrics({ imageId, src, initialMetrics }: ImageWithMetricsProps) {
    const [metrics, setMetrics] = useState(initialMetrics || {
        views: 0,
        likes: 0,
        downloads: 0
    });

    useEffect(() => {
        const handleMetricUpdate = (event: CustomEvent) => {
            if (event.detail.imageId === imageId) {
                setMetrics(prev => ({
                    views: event.detail.metrics.views?.total ?? prev.views,
                    likes: event.detail.metrics.likes?.total ?? prev.likes,
                    downloads: event.detail.metrics.downloads?.total ?? prev.downloads
                }));
            }
        };

        document.addEventListener('image-metrics-update', handleMetricUpdate as any);

        return () => {
            document.removeEventListener('image-metrics-update', handleMetricUpdate as any);
        };
    }, [imageId]);

    return (
        <div className="image-container">
            <img
                src={src}
                data-image-id={imageId}
                alt="Content"
            />
            <div className="metrics">
                <span>👁 {metrics.views.toLocaleString()}</span>
                <span>❤️ {metrics.likes.toLocaleString()}</span>
                <span>⬇️ {metrics.downloads.toLocaleString()}</span>
            </div>
        </div>
    );
}
```

## Performance Considerations

### Client-Side
- **Debounce subscriptions**: Wait for scroll to settle before subscribing
- **Batch operations**: Subscribe/unsubscribe to multiple images at once
- **Connection pooling**: Reuse single SignalR connection for all subscriptions
- **Cleanup**: Always unsubscribe when components unmount or images leave viewport

### Server-Side
- **Batch metric updates**: Group multiple updates into single API calls when possible
- **Rate limiting**: Implement throttling to prevent overwhelming the Signals API
- **Delta compression**: Only send changed metrics, not full objects
- **Caching**: Cache last known values to calculate accurate deltas

### Example Rate Limiter
```typescript
class RateLimitedMetricService {
    private queue: Map<string, any> = new Map();
    private timer: NodeJS.Timeout | null = null;
    private signalService: MetricSignalService;

    constructor(private batchIntervalMs = 1000) {
        this.signalService = new MetricSignalService();
    }

    queueMetricUpdate(imageId: string, metrics: any) {
        this.queue.set(imageId, metrics);

        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.batchIntervalMs);
        }
    }

    private async flush() {
        if (this.queue.size === 0) return;

        const updates = Array.from(this.queue.entries()).map(([imageId, metrics]) => ({
            imageId,
            metrics
        }));

        await this.signalService.sendBatchMetricUpdates(updates);

        this.queue.clear();
        this.timer = null;
    }
}
```

## Testing

### Manual Testing
```typescript
// Test sending a metric update
const testMetricUpdate = async () => {
    const response = await fetch('http://localhost:5000/topics/image:test123:metrics/signals/metrics:update', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            imageId: 'test123',
            metrics: {
                views: { delta: 1, total: 100 },
                likes: { delta: 1, total: 10 }
            },
            timestamp: Date.now()
        })
    });

    console.log('Update sent:', response.status);
};
```

## Troubleshooting

### Common Issues

1. **Connection fails**: Check access token is valid and `/hub` endpoint is accessible
2. **No updates received**: Verify topic name format matches exactly (`image:${imageId}:metrics`)
3. **High latency**: Consider batching updates and implementing local optimistic updates
4. **Memory leaks**: Ensure proper cleanup of subscriptions and event listeners