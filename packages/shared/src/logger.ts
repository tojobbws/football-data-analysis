export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Structured JSON logger (one line per event, easy to grep in GitHub Actions logs). */
export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const write = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...bindings, ...meta });
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return {
    debug: (m, x) => write('debug', m, x),
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x),
    child: (b) => createLogger(level, { ...bindings, ...b }),
  };
}
