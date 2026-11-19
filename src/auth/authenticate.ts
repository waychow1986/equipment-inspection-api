import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../http/errors.js';
import type { Principal, Role, TokenTable } from './token-config.js';

const MAX_TOKEN_LENGTH = 512;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Role required by an authenticated route; routes without it are public. */
    allowedRole?: Role;
  }
  interface FastifyRequest {
    principal: Principal | null;
    errorCode: string | null;
  }
}

export function parseBearer(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  if (!match) return undefined;
  const token = match[1] as string;
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  return token;
}

/**
 * onRequest hook: runs before body parsing so the order is 401 → 403 → 400.
 */
export function createAuthHook(tokens: TokenTable) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const allowedRole = request.routeOptions.config.allowedRole;
    if (!allowedRole) return;
    const token = parseBearer(request.headers.authorization);
    const principal = token === undefined ? undefined : tokens.lookup(token);
    if (!principal) {
      reply.header('WWW-Authenticate', 'Bearer');
      return sendError(reply, 'UNAUTHENTICATED');
    }
    if (principal.role !== allowedRole) return sendError(reply, 'FORBIDDEN');
    request.principal = principal;
  };
}
