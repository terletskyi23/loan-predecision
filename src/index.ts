import { loadConfigOrExit } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createMetrics } from './metrics.js';
import { buildServer } from './http/server.js';

/**
 * Composition root. The only place that knows how the pieces fit together, and
 * the reason the domain layer can be reached by nothing (ADR-0008).
 *
 * Configuration is validated before anything is constructed and before a port is
 * bound: a bad value is a failed deploy, not a service answering requests
 * insecurely. docs/06-failure-modes.md, Deployment.
 */
const config = loadConfigOrExit();
const logger = createLogger(config);

/**
 * Migrations before anything binds a port. A half-migrated schema serving
 * requests is worse than a failed deploy, so this either succeeds or the
 * process exits — docs/06-failure-modes.md, Database.
 */
if (config.MIGRATE_ON_BOOT) {
  try {
    const result = await runMigrations(config, logger);
    logger.info(result, 'schema ready');
  } catch (error) {
    logger.error({ err: error }, 'migration failed; refusing to serve against a half-migrated schema');
    process.exit(1);
  }
}

const database = createDatabase(config, logger);
const metrics = createMetrics();
const app = await buildServer({ config, logger, database, metrics });

/**
 * Order matters: stop accepting requests, then release the pool. Closing the
 * pool first would fail every request still in flight.
 */
const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down');
  void app
    .close()
    .then(() => database.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  logger.error({ err: error }, 'failed to start');
  process.exit(1);
}
