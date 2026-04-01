/**
 * Centralized logging system with debug mode support
 * Set DEBUG=* or DEBUG=app:* to enable debug logging
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  module?: string;
  requestId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

class Logger {
  private debugEnabled: boolean;
  private context: LogContext = {};

  constructor(private moduleName: string = 'app') {
    // Check environment for debug mode
    const debug = process.env.DEBUG || '';
    this.debugEnabled =
      debug === '*' ||
      debug === 'app:*' ||
      debug.includes(this.moduleName);
  }

  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.moduleName}]`;

    if (level === 'debug' && !this.debugEnabled) return;

    const logFn = this.getLogFunction(level);
    if (data) {
      logFn(`${prefix} ${message}`, data);
    } else {
      logFn(`${prefix} ${message}`);
    }
  }

  private getLogFunction(level: LogLevel): (...args: unknown[]) => void {
    switch (level) {
      case 'error':
        return console.error;
      case 'warn':
        return console.warn;
      case 'debug':
        return console.debug;
      case 'info':
      default:
        return console.log;
    }
  }

  debug(message: string, data?: unknown): void {
    this.formatMessage('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.formatMessage('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.formatMessage('warn', message, data);
  }

  error(message: string, error?: Error | unknown, data?: unknown): void {
    const errorInfo = this.formatError(error);
    this.formatMessage('error', message, { ...errorInfo, ...data });
  }

  private formatError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        errorName: error.name,
        errorMessage: error.message,
        stack: error.stack,
      };
    }
    return { error: String(error) };
  }
}

// Export singleton instances
export const createLogger = (moduleName: string): Logger => {
  return new Logger(moduleName);
};

export default Logger;
