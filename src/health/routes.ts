import type { FastifyInstance } from 'fastify';

export type HealthCheck = () => Promise<boolean>;

const HEALTH_TIMEOUT_MS = 2000;

async function withTimeout(check: HealthCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoute(app: FastifyInstance, check: HealthCheck): void {
  app.get('/healthz', async (_request, reply) => {
    const ok = await withTimeout(check);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
  });
}
