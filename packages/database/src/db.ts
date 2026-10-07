import pg from 'pg';

/** Minimal query interface. Implemented by node-postgres (prod) and PGlite (tests). */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Queryable {
  /** Run a multi-statement SQL script (no parameters). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres / Supabase connection used by workers (service-level access, bypasses RLS). */
export function createPgDb(connectionString: string, opts: { max?: number } = {}): Db {
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 5,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });

  const query: Queryable['query'] = async <R>(text: string, params?: unknown[]) => {
    const res = await pool.query(text, params as unknown[]);
    return { rows: res.rows as R[] };
  };

  return {
    query,
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tx: Queryable = {
          query: async <R>(text: string, params?: unknown[]) => {
            const res = await client.query(text, params as unknown[]);
            return { rows: res.rows as R[] };
          },
        };
        const out = await fn(tx);
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
