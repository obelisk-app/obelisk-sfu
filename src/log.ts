/**
 * Tag-prefixed leveled logger. Tiny on purpose — one file, zero deps.
 *
 * Convention: every module gets its own logger with a short tag, so a
 * grep on the tag in `tail -f` zeroes in on a single subsystem.
 *
 *   const log = createLogger('relay');
 *   log.info('connected', { url });
 *
 *   → 2026-05-04T12:34:56.789Z INFO  [relay] connected url=wss://...
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const env = (process.env.SFU_LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.info;
}

function fmt(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level: Level, tag: string, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const ts = new Date().toISOString();
  const lvl = level.toUpperCase().padEnd(5);
  const kv = extra
    ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
    : '';
  const line = `${ts} ${lvl} [${tag}] ${msg}${kv}`;
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(suffix: string): Logger;
}

export function createLogger(tag: string): Logger {
  return {
    debug: (m, e) => emit('debug', tag, m, e),
    info:  (m, e) => emit('info',  tag, m, e),
    warn:  (m, e) => emit('warn',  tag, m, e),
    error: (m, e) => emit('error', tag, m, e),
    child: (suffix) => createLogger(`${tag}:${suffix}`),
  };
}
