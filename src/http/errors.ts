import type { FastifyReply } from 'fastify';
import type { FieldError } from '../inspections/validation.js';

export const ERRORS = {
  UNAUTHENTICATED: { status: 401, message: '未识别身份' },
  FORBIDDEN: { status: 403, message: '无权执行该操作' },
  VALIDATION_FAILED: { status: 400, message: '输入不符合要求' },
  NOT_FOUND: { status: 404, message: '资源不存在' },
  SERVICE_UNAVAILABLE: { status: 503, message: '服务暂不可用' },
  INTERNAL_ERROR: { status: 500, message: '服务内部错误' },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export interface ErrorBody {
  error: { code: ErrorCode; message: string; fields?: FieldError[] };
}

export function errorBody(code: ErrorCode, fields?: FieldError[]): ErrorBody {
  const body: ErrorBody = { error: { code, message: ERRORS[code].message } };
  if (fields) body.error.fields = fields;
  return body;
}

export function sendError(reply: FastifyReply, code: ErrorCode, options: { status?: number; fields?: FieldError[] } = {}) {
  reply.request.errorCode = code;
  return reply.code(options.status ?? ERRORS[code].status).send(errorBody(code, options.fields));
}

const DB_UNAVAILABLE_NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN']);

/** True when the failure means the database cannot currently serve requests (→ 503). */
export function isDbUnavailable(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string') {
    if (DB_UNAVAILABLE_NET_CODES.has(code)) return true;
    if (code.startsWith('08') || code.startsWith('57P0') || code.startsWith('53') || code === '57014') return true;
  }
  if (typeof message === 'string') {
    if (/timeout/i.test(message) || message.includes('Connection terminated')) return true;
  }
  return false;
}
