// Environment-controlled logging utility
// Set DEBUG_EVENT_ENGINE=true or NODE_ENV=development to enable logging

interface LogLevel {
  DEBUG: number;
  INFO: number;
  WARN: number;
  ERROR: number;
}

const LOG_LEVELS: LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class EventEngineLogger {
  private enabled: boolean;
  private logLevel: number;
  private enabledComponents: Set<string>;

  constructor() {
    // Enable logging if DEBUG_EVENT_ENGINE is set or NODE_ENV is development
    this.enabled =
      process.env.DEBUG_EVENT_ENGINE === 'true' ||
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test';

    // Set log level from environment, default to DEBUG if enabled
    const envLogLevel = process.env.EVENT_ENGINE_LOG_LEVEL?.toUpperCase() as keyof LogLevel;
    this.logLevel = this.enabled ? (LOG_LEVELS[envLogLevel] ?? LOG_LEVELS.DEBUG) : LOG_LEVELS.ERROR;

    // Parse enabled components from environment
    // Format: DEBUG_EVENT_ENGINE_COMPONENTS=MetricService,ImageFeedService,Redis
    // If not set, all components are enabled by default
    const enabledComponentsEnv = process.env.DEBUG_EVENT_ENGINE_COMPONENTS;
    if (enabledComponentsEnv) {
      this.enabledComponents = new Set(
        enabledComponentsEnv.split(',').map(c => c.trim())
      );
    } else {
      // All components enabled by default
      this.enabledComponents = new Set(['*']);
    }
  }

  private shouldLog(level: number, component?: string): boolean {
    if (!this.enabled || level < this.logLevel) {
      return false;
    }

    // If no component specified, use general enabled check
    if (!component) {
      return true;
    }

    // Check if specific component is enabled
    return this.enabledComponents.has('*') || this.enabledComponents.has(component);
  }

  private formatMessage(component: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${component}] ${message}`;
  }

  debug(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
      console.debug(this.formatMessage(component, message), ...args);
    }
  }

  info(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.INFO, component)) {
      console.info(this.formatMessage(component, message), ...args);
    }
  }

  warn(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.WARN, component)) {
      console.warn(this.formatMessage(component, message), ...args);
    }
  }

  error(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.ERROR, component)) {
      console.error(this.formatMessage(component, message), ...args);
    }
  }

  // Convenience methods for common use cases
  metric(message: string, ...args: any[]): void {
    this.debug('MetricService', message, ...args);
  }

  redis(message: string, ...args: any[]): void {
    this.debug('RedisHelpers', message, ...args);
  }

  clickhouse(message: string, ...args: any[]): void {
    this.debug('ClickHouse', message, ...args);
  }

  imageFeed(message: string, ...args: any[]): void {
    this.debug('ImageFeedService', message, ...args);
  }

  modelFeed(message: string, ...args: any[]): void {
    this.debug('ModelFeedService', message, ...args);
  }

  // Performance timing helpers
  time(component: string, label: string): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
      console.time(this.formatMessage(component, label));
    }
  }

  timeEnd(component: string, label: string): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
      console.timeEnd(this.formatMessage(component, label));
    }
  }

  // Structured logging for complex objects
  logObject(component: string, message: string, obj: any): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
      this.debug(component, message);
      console.table(obj);
    }
  }

  // Check if logging is enabled (useful for expensive operations)
  get isEnabled(): boolean {
    return this.enabled;
  }

  get isDebugEnabled(): boolean {
    return this.shouldLog(LOG_LEVELS.DEBUG);
  }

  // Check if specific component is enabled
  isComponentEnabled(component: string): boolean {
    return this.shouldLog(LOG_LEVELS.DEBUG, component);
  }
}

// Export singleton instance
export const logger = new EventEngineLogger();

// Export for testing/configuration
export { EventEngineLogger, LOG_LEVELS };