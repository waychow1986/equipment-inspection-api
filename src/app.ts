import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { createAuthHook } from './auth/authenticate.js';
import type { TokenTable } from './auth/token-config.js';
import { registerHealthRoute, type HealthCheck } from './health/routes.js';
import { isDbUnavailable, sendError } from './http/errors.js';
import type { InspectionRepository } from './inspections/repository.js';
import { registerInspectionRoutes } from './inspections/routes.js';
import { registerOpenApiRoute } from './openapi/routes.js';

export const BODY_LIMIT_BYTES = 16 * 1024;

export interface AppDependencies {
  tokens: TokenTable;
  repository: InspectionRepository;
  healthCheck: HealthCheck;
  logger: Logger;
}

function isBodyError(err: FastifyError): boolean {
  return typeof err.code === 'string' && err.code.startsWith('FST_ERR_CTP_');
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const { logger } = deps;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: true,
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('errorCode', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });
  app.addHook('onRequest', createAuthHook(deps.tokens));

  app.addHook('onResponse', async (request, reply) => {
    const entry: Record<string, unknown> = {
      event: 'access',
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 10) / 10,
    };
    if (request.errorCode) entry.errorCode = request.errorCode;
    if (reply.statusCode >= 500) logger.error(entry, 'request completed');
    else logger.info(entry, 'request completed');
  });

  app.setNotFoundHandler(async (_request, reply) => sendError(reply, 'NOT_FOUND'));

  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    if (isBodyError(err)) {
      if (err.statusCode === 413) {
        return sendError(reply, 'VALIDATION_FAILED', { status: 413, fields: [{ field: 'body', reason: 'TOO_LARGE' }] });
      }
      if (err.statusCode !== undefined && err.statusCode < 500) {
        return sendError(reply, 'VALIDATION_FAILED', { status: 400, fields: [{ field: 'body', reason: 'MALFORMED' }] });
      }
    }
    const unavailable = isDbUnavailable(err);
    logger.error(
      { event: unavailable ? 'db_unavailable' : 'request_failed', requestId: request.id, err },
      unavailable ? 'database unavailable' : 'request failed',
    );
    return sendError(reply, unavailable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR');
  });

  registerHealthRoute(app, deps.healthCheck);
  registerOpenApiRoute(app);
  registerInspectionRoutes(app, deps.repository);

  return app;
}
