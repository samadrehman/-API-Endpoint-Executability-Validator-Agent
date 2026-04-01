/**
 * Centralized error handling with recovery strategies
 * Classifies errors and provides actionable messages
 */

import { createLogger } from './logger';

const logger = createLogger('error-handler');

export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 500,
    public cause?: Error,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, suggestion?: string) {
    super('CONFIG_ERROR', message, 400, undefined, suggestion);
    this.name = 'ConfigError';
  }
}

export class AuthError extends AppError {
  constructor(message: string, suggestion?: string) {
    super('AUTH_ERROR', message, 401, undefined, suggestion);
    this.name = 'AuthError';
  }
}

export class ApiError extends AppError {
  constructor(
    public httpStatus: number,
    message: string,
    suggestion?: string
  ) {
    const code = httpStatus === 404 ? 'NOT_FOUND' : 'API_ERROR';
    super(code, message, httpStatus, undefined, suggestion);
    this.name = 'ApiError';
  }
}

export function handleError(error: unknown): AppError {
  // Already an AppError
  if (error instanceof AppError) {
    return error;
  }

  // Handle HTTP-like errors with status codes
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    if (typeof err.statusCode === 'number') {
      const status = err.statusCode as number;
      const msg = String(err.message || 'API request failed');
      const suggestion = getSuggestionForStatus(status);
      logger.error('API Error', error, { statusCode: status });
      return new ApiError(status, msg, suggestion);
    }

    if (typeof err.code === 'number') {
      const code = err.code as number;
      const msg = String(err.message || 'Unknown error');
      const suggestion = getSuggestionForStatus(code);
      logger.error('API Error', error, { code });
      return new ApiError(code, msg, suggestion);
    }
  }

  // Generic Error object
  if (error instanceof Error) {
    const suggestion = getSuggestionForMessage(error.message);
    logger.error('Unexpected error', error);
    return new AppError('UNKNOWN_ERROR', error.message, 500, error, suggestion);
  }

  // Unknown error type
  const msg = String(error);
  logger.error('Unknown error type', error);
  return new AppError('UNKNOWN_ERROR', msg, 500, undefined, 'See logs for details');
}

function getSuggestionForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Invalid request parameters. Check the endpoint definition and try again.';
    case 401:
      return 'Authentication failed. Run scaffold.sh and connect.ts to refresh credentials.';
    case 403:
      return 'Insufficient permissions. Verify required scopes are enabled for this account.';
    case 404:
      return 'Endpoint not found. This may be a fake/deprecated endpoint.';
    case 429:
      return 'Rate limited. Wait a moment and retry.';
    case 500:
    case 502:
    case 503:
      return 'Server error. The upstream API may be temporarily unavailable.';
    default:
      return status >= 400 && status < 500
        ? 'Client error. Check request format.'
        : 'Server error. Retry in a moment.';
  }
}

function getSuggestionForMessage(msg: string): string {
  const lower = msg.toLowerCase();

  if (lower.includes('enoent') || lower.includes('not found')) {
    return 'File or resource not found. Check paths and environment setup.';
  }
  if (lower.includes('eacces') || lower.includes('permission')) {
    return 'Permission denied. Check file permissions and authentication.';
  }
  if (lower.includes('timeout')) {
    return 'Request timeout. The API took too long to respond. Check your network and retry.';
  }
  if (lower.includes('econnrefused')) {
    return 'Connection refused. Verify the API endpoint is accessible.';
  }
  if (lower.includes('channel')) {
    return 'Connection error. Your session may have been interrupted. Try reconnecting.';
  }

  return 'See error details in the logs.';
}

export function logErrorWithContext(error: unknown, context: Record<string, unknown>): void {
  const appError = handleError(error);
  logger.error(appError.message, appError, context);

  if (appError.suggestion) {
    logger.info(`💡 Suggestion: ${appError.suggestion}`);
  }
}
