import { loadConfigOrExit } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createMetrics } from './metrics.js';
import { buildServer } from './http/server.js';
import { createFilePolicyStore } from './policy/loader.js';
import { createServices } from './services/index.js';

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

/**
 * The configured policy is loaded and validated before a port is bound, for the
 * same reason the environment is: a policy file that is well-formed JSON but
 * incoherent would otherwise boot cleanly and fail on the first real
 * application. `src/domain/policy.ts` explains what "incoherent" is checked to
 * mean. Old versions are loaded lazily on replay; this only proves today's.
 */
const policies = createFilePolicyStore(config.POLICY_DIR);
try {
  const policy = await policies.get(config.POLICY_VERSION);
  // policyVersion is already a base binding on the logger; what is worth adding
  // is evidence the file was read and understood, not the version again.
  logger.info(
    { factors: policy.scorecard.factors.length, reasonCodes: policy.reasonCodes.registry.length },
    'policy loaded',
  );
} catch (error) {
  logger.error({ err: error }, 'policy is invalid or missing; refusing to serve without rules');
  process.exit(1);
}

const database = createDatabase(config, logger);
const metrics = createMetrics();

/**
 * The composition root. Everything above is constructed; nothing constructs
 * itself. This is what ADR-0008 buys instead of a DI container: wiring that can
 * be read top to bottom, and a domain layer reached by nothing because nothing
 * here hands it anything but plain values.
 */
const app = await buildServer({
  config,
  logger,
  database,
  metrics,
  services: createServices({ config, database, policies, metrics, logger }),
});

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
