import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(new URL('../../dist/server.js', import.meta.url));

export interface TestToken {
  token: string;
  sha256: string;
  holder: string;
  role: 'inspector' | 'manager';
}

export function makeToken(role: TestToken['role'], holder = `t.${role}.${randomBytes(4).toString('hex')}`): TestToken {
  const token = randomBytes(32).toString('base64url');
  return { token, sha256: createHash('sha256').update(token, 'utf8').digest('hex'), holder, role };
}

export function tokenList(tokens: TestToken[]): string {
  return JSON.stringify(tokens.map(({ sha256, holder, role }) => ({ sha256, holder, role })));
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/** Every byte the service wrote to stdout/stderr during this test run, for the zero-hit log check. */
export const capturedOutput: string[] = [];

export interface RunningService {
  baseUrl: string;
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<number | null>;
}

export function runService(env: Record<string, string>): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const chunks: string[] = [];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (buf: Buffer) => {
    const text = buf.toString('utf8');
    chunks.push(text);
    capturedOutput.push(text);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output: () => chunks.join(''), exited };
}

export async function startService(env: Record<string, string>, timeoutMs = 60_000): Promise<RunningService> {
  const port = Number(env.PORT);
  const { child, output, exited } = runService(env);
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode: number | null | undefined;
  void exited.then((c) => (exitCode = c));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exitCode !== undefined) throw new Error(`service exited during startup with code ${exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('service did not become healthy in time');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    baseUrl,
    child,
    output,
    stop: async () => {
      if (exitCode !== undefined) return exitCode;
      child.kill('SIGTERM');
      return exited;
    },
  };
}
