import http from 'http';
import { logger } from './utils/logger';
import { HealthCheckService } from './services/health-check';
import { getEventProcessor } from './services/event-processor';
import { config } from './config';
import { register } from './metrics';

const PORT = config.app.healthCheckPort;

/**
 * Simple HTTP server for health checks and metrics
 */
export function startHealthServer() {
  const healthService = HealthCheckService.getInstance();

  const server = http.createServer(async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      // Health check endpoint
      if (req.url === '/health') {
        const health = await healthService.getHealth();
        const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
        return;
      }

      // Readiness check - stricter than liveness
      if (req.url === '/ready') {
        const health = await healthService.getHealth();
        const isReady = health.status === 'healthy';
        const statusCode = isReady ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ready: isReady,
          status: health.status,
          timestamp: health.timestamp
        }, null, 2));
        return;
      }

      // Liveness check - just verify the process is running
      if (req.url === '/live') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          alive: true,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // Prometheus metrics endpoint
      if (req.url === '/metrics') {
        // Update gauges with current values
        const eventProcessor = getEventProcessor();
        eventProcessor.getStats();

        // Serve Prometheus metrics
        const metrics = await register.metrics();
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(metrics);
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error({ err }, 'Health check endpoint error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(PORT, () => {
    logger.info(`Health check server listening on port ${PORT}`);
    logger.info(`  GET /health  - Health check (liveness + readiness)`);
    logger.info(`  GET /ready   - Readiness probe`);
    logger.info(`  GET /live    - Liveness probe`);
    logger.info(`  GET /metrics - Service metrics`);
  });

  return server;
}
