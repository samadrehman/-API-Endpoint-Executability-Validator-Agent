/**
 * Configuration validation and initialization
 * Validates all required env vars at startup
 */

import { createLogger } from './logger';
import { ConfigError } from './error-handler';

const logger = createLogger('config');

export interface Config {
  composioApiKey: string;
  gmailAuthConfigId: string;
  calendarAuthConfigId: string;
  gmailConnectedId: string;
  calendarConnectedId: string;
  debug: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Validates and loads configuration from environment variables
 * @throws ConfigError if required variables are missing
 */
export function loadConfig(): Config {
  const debug = process.env.DEBUG === '*' || process.env.DEBUG === 'app:*';
  const logLevel = (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info';

  logger.info('Loading configuration...', { debug, logLevel });

  const required = {
    composioApiKey: process.env.COMPOSIO_API_KEY,
    gmailAuthConfigId: process.env.GMAIL_AUTH_CONFIG_ID,
    calendarAuthConfigId: process.env.GOOGLECALENDAR_AUTH_CONFIG_ID,
  };

  const optional = {
    gmailConnectedId: process.env.GMAIL_CONNECTED_ACCOUNT_ID,
    calendarConnectedId: process.env.GOOGLECALENDAR_CONNECTED_ACCOUNT_ID,
  };

  // Check which required vars are missing
  const missing: string[] = [];
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const suggestion = `
Setup Steps:
1. Copy .env.example to .env
2. Run: COMPOSIO_API_KEY=<your-key> sh scaffold.sh
3. Run: bun src/connect.ts
4. Fill in all variables in .env
5. Source the .env: source .env (Unix) or set in .env
    `;

    throw new ConfigError(
      `Missing required env variables: ${missing.join(', ')}`,
      suggestion
    );
  }

  // Check optional vars
  if (!optional.gmailConnectedId || !optional.calendarConnectedId) {
    const missing_optional = [];
    if (!optional.gmailConnectedId) missing_optional.push('GMAIL_CONNECTED_ACCOUNT_ID');
    if (!optional.calendarConnectedId) missing_optional.push('GOOGLECALENDAR_CONNECTED_ACCOUNT_ID');

    logger.warn(
      `Optional env variables not set: ${missing_optional.join(', ')}`,
      { note: 'Run bun src/connect.ts to set these up' }
    );
  }

  const config: Config = {
    composioApiKey: required.composioApiKey!,
    gmailAuthConfigId: required.gmailAuthConfigId!,
    calendarAuthConfigId: required.calendarAuthConfigId!,
    gmailConnectedId: optional.gmailConnectedId || '',
    calendarConnectedId: optional.calendarConnectedId || '',
    debug,
    logLevel,
  };

  logger.info('Configuration loaded successfully', {
    hasApiKey: !!config.composioApiKey,
    hasGmailAuth: !!config.gmailAuthConfigId,
    hasCalendarAuth: !!config.calendarAuthConfigId,
    hasGmailConnected: !!config.gmailConnectedId,
    hasCalendarConnected: !!config.calendarConnectedId,
  });

  return config;
}

/**
 * Safe config loading with fallback
 */
export function loadConfigSafely(): Config | null {
  try {
    return loadConfig();
  } catch (error) {
    logger.error('Failed to load config', error);
    return null;
  }
}
