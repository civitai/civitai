import { DebeziumManager } from './debezium-manager';
import { logger } from '../utils/logger';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    kafka: boolean;
    debezium?: boolean;
    database: boolean;
    redis?: boolean;
  };
  timestamp: string;
}

export class HealthCheckService {
  private static instance: HealthCheckService;

  private constructor() {}

  public static getInstance(): HealthCheckService {
    if (!HealthCheckService.instance) {
      HealthCheckService.instance = new HealthCheckService();
    }
    return HealthCheckService.instance;
  }

  public async getHealth(): Promise<HealthStatus> {
    // Check if Debezium is configured
    const debeziumConfigured = !!process.env.DEBEZIUM_CONNECT_URL;

    const services = {
      kafka: await this.checkKafka(),
      ...(debeziumConfigured ? { debezium: await this.checkDebezium() } : {}),
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
    };

    const allHealthy = Object.values(services).every(status => status === true);
    const someHealthy = Object.values(services).some(status => status === true);

    const status: HealthStatus = {
      status: allHealthy ? 'healthy' : someHealthy ? 'degraded' : 'unhealthy',
      services,
      timestamp: new Date().toISOString(),
    };

    return status;
  }

  private async checkKafka(): Promise<boolean> {
    try {
      const { Kafka } = require('kafkajs');
      const kafkaBrokers = process.env.KAFKA_BROKERS || 'localhost:9092';
      const kafka = new Kafka({
        clientId: 'health-check',
        brokers: kafkaBrokers.split(','),
      });

      const admin = kafka.admin();
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      return true;
    } catch (err) {
      logger.error({ err }, 'Kafka health check failed');
      return false;
    }
  }

  private async checkDebezium(): Promise<boolean> {
    try {
      const debeziumManager = DebeziumManager.getInstance();
      return await debeziumManager.isHealthy();
    } catch (err) {
      logger.error({ err }, 'Debezium health check failed');
      return false;
    }
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      // Simple check - can we parse the DATABASE_URL
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) return false;

      // In production, you might want to actually query the database
      // For now, just check if the URL is valid
      new URL(databaseUrl);
      return true;
    } catch (err) {
      logger.error({ err }, 'Database health check failed');
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) return true; // Redis is optional

      // In production, you might want to actually ping Redis
      // For now, just check if the URL is valid
      new URL(redisUrl);
      return true;
    } catch (err) {
      logger.error({ err }, 'Redis health check failed');
      return false;
    }
  }
}