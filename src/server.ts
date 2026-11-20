import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createWriterPool } from './db/pool.js';
import { createPgRepository } from './inspections/repository.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const bootLogger = createLogger({ level: 'info' });

  process.on('uncaughtException', (err) => {
    bootLogger.fatal({ event: 'uncaught_exception', err }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    bootLogger.fatal({ event: 'unhandled_rejection', err: reason }, 'unhandled rejection');
    process.exit(1);
  });

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      bootLogger.fatal(
        { event: 'config_invalid', variable: err.variable, reason: err.reason, entryIndex: err.entryIndex },
        '配置无效',
      );
    } else {
      bootLogger.fatal({ event: 'config_invalid', err }, '配置无效');
    }
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });
  if (config.tokens.size === 0) logger.warn({ event: 'tokens_empty', tokenCount: 0 }, '未配置任何访问令牌');

  try {
    await runMigrations({ db: config.db, schema: config.schema, writerRole: config.writerRole, logger });
  } catch (err) {
    logger.fatal({ event: 'startup_failed', err }, 'startup failed');
    process.exit(1);
  }

  const pool = createWriterPool({ db: config.db, writerRole: config.writerRole, max: config.poolMax, logger });
  const app = buildApp({
    tokens: config.tokens,
    repository: createPgRepository(pool, config.schema),
    healthCheck: async () => {
      await pool.query('SELECT 1');
      return true;
    },
    logger,
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info({ event: 'service_started', port: config.port, tokenCount: config.tokens.size }, 'service started');

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown' }, 'shutting down');
    const force = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    app
      .close()
      .then(() => pool.end())
      .catch((err: unknown) => logger.error({ event: 'shutdown_failed', err }, 'shutdown failed'))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
