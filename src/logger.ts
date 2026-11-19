import pino, { type DestinationStream, type Logger } from 'pino';

/** Only these keys may reach the log output; everything else is dropped. */
const ALLOWED_KEYS = new Set([
  'event',
  'requestId',
  'method',
  'route',
  'statusCode',
  'durationMs',
  'errorCode',
  'errName',
  'errCode',
  'variable',
  'entryIndex',
  'reason',
  'tokenCount',
  'port',
]);

function errorSummary(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  const { name, code } = value as { name?: unknown; code?: unknown };
  if (typeof name === 'string') out.errName = name;
  if (typeof code === 'string' || typeof code === 'number') out.errCode = String(code);
  return out;
}

export function sanitizeLogObject(obj: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'err' || key === 'error') {
      Object.assign(out, errorSummary(value));
    } else if (ALLOWED_KEYS.has(key)) {
      const t = typeof value;
      if (t === 'string' || t === 'number' || t === 'boolean') out[key] = value;
    }
  }
  return out;
}

export interface LoggerOptions {
  level: string;
  destination?: DestinationStream;
}

/** pino does not pass child bindings through formatters.bindings, so filter them here. */
function guardChildren<T extends Logger>(logger: T): T {
  type ChildFn = (bindings: Record<string, unknown>, options?: unknown) => Logger;
  const originalChild = (logger.child as unknown as ChildFn).bind(logger);
  const guarded: ChildFn = (bindings, childOptions) =>
    guardChildren(originalChild(sanitizeLogObject(bindings), childOptions));
  (logger as unknown as { child: ChildFn }).child = guarded;
  return logger;
}

export function createLogger(options: LoggerOptions): Logger {
  return guardChildren(pino(
    {
      level: options.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => sanitizeLogObject(bindings),
        log: (obj) => sanitizeLogObject(obj),
      },
      redact: {
        paths: ['req.headers.authorization', 'headers.authorization', '*.password', '*.token', '*.sha256'],
        remove: true,
      },
    },
    options.destination ?? pino.destination({ dest: 1, sync: true }),
  ));
}
