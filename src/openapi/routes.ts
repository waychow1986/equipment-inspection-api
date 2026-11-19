import type { FastifyInstance } from 'fastify';
import { openApiDocument } from './document.js';

const serialized = JSON.stringify(openApiDocument);

export function registerOpenApiRoute(app: FastifyInstance): void {
  app.get('/openapi.json', async (_request, reply) => {
    return reply
      .header('Cache-Control', 'no-cache')
      .type('application/json; charset=utf-8')
      .send(serialized);
  });
}
