import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/**
 * docs/04-audit.md §6: redaction is configured on the serialisers, not left to
 * discipline at each call site — because sooner or later somebody logs the whole
 * object. The paths below are deliberately broader than what the code currently
 * logs; the cost of a redundant path is nothing, and the cost of a missing one
 * is a national identifier in a log aggregator.
 */
const REDACT = [
  'req.headers.authorization',
  'headers.authorization',
  'nationalId',
  '*.nationalId',
  'applicant',
  '*.applicant',
  'body.applicant',
  'req.body.applicant',
  'payload',
  '*.payload',
];

export const createLogger = (config: Config): Logger =>
  pino({
    level: config.LOG_LEVEL,
    redact: { paths: REDACT, censor: '[redacted]' },
    base: { policyVersion: config.POLICY_VERSION, engineVersion: config.ENGINE_VERSION },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } }
      : {}),
  });
