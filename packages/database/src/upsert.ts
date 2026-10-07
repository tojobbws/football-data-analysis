import type { Queryable } from './db.js';

export type Row = Record<string, unknown>;

export interface WriteOptions {
  /** Conflict target columns (unique / primary key). */
  conflict: string[];
  /**
   * Columns to update on conflict.
   * 'all' (default) = every non-conflict column present in the rows.
   * 'nothing' = ON CONFLICT DO NOTHING (used for stubs and append-only tables).
   */
  update?: string[] | 'all' | 'nothing';
  /** Column set to now() on update (e.g. 'synced_at'). */
  touch?: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_PARAMS = 60_000;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

/** JS value -> pg parameter. Objects/arrays are sent as JSON text (jsonb columns). */
export function toParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Keep the last row for each conflict key (Postgres rejects duplicates in one statement). */
export function dedupeBy(rows: Row[], keys: string[]): Row[] {
  const map = new Map<string, Row>();
  for (const r of rows) map.set(JSON.stringify(keys.map((k) => r[k] ?? null)), r);
  return [...map.values()];
}

/**
 * Multi-row INSERT ... ON CONFLICT, chunked under the parameter limit.
 * Missing keys in a row use the column DEFAULT (never overwrite with NULL by accident).
 * Returns number of rows inserted or updated.
 */
export async function writeRows(db: Queryable, table: string, input: Row[], opts: WriteOptions): Promise<number> {
  if (input.length === 0) return 0;
  const rows = dedupeBy(input, opts.conflict);
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  columns.forEach(ident);
  opts.conflict.forEach(ident);

  let conflictSql: string;
  const mode = opts.update ?? 'all';
  if (mode === 'nothing') {
    conflictSql = `on conflict (${opts.conflict.map(ident).join(', ')}) do nothing`;
  } else {
    const updateCols = (mode === 'all' ? columns : mode).filter((c) => !opts.conflict.includes(c));
    const sets = updateCols.map((c) => `${ident(c)} = excluded.${ident(c)}`);
    if (opts.touch) sets.push(`${ident(opts.touch)} = now()`);
    conflictSql = sets.length
      ? `on conflict (${opts.conflict.map(ident).join(', ')}) do update set ${sets.join(', ')}`
      : `on conflict (${opts.conflict.map(ident).join(', ')}) do nothing`;
  }

  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params: unknown[] = [];
    const values = chunk.map((r) => {
      const cells = columns.map((c) => {
        if (!(c in r)) return 'default';
        params.push(toParam(r[c]));
        return `$${params.length}`;
      });
      return `(${cells.join(', ')})`;
    });
    const sql = `insert into ${ident(table)} (${columns.map(ident).join(', ')}) values ${values.join(', ')} ${conflictSql} returning 1 as ok`;
    const res = await db.query(sql, params);
    written += res.rows.length;
  }
  return written;
}

/** Plain multi-row INSERT without conflict handling. Returns rows inserted. */
export async function insertRows(db: Queryable, table: string, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  columns.forEach(ident);
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const params: unknown[] = [];
    const values = rows.slice(i, i + perChunk).map((r) => {
      const cells = columns.map((c) => {
        if (!(c in r)) return 'default';
        params.push(toParam(r[c]));
        return `$${params.length}`;
      });
      return `(${cells.join(', ')})`;
    });
    const res = await db.query(`insert into ${ident(table)} (${columns.map(ident).join(', ')}) values ${values.join(', ')} returning 1 as ok`, params);
    written += res.rows.length;
  }
  return written;
}

/** Plain INSERT of one row, returning the given column. */
export async function insertReturning<T = number>(db: Queryable, table: string, row: Row, returning = 'id'): Promise<T> {
  const cols = Object.keys(row);
  const params = cols.map((c) => toParam(row[c]));
  const sql = `insert into ${ident(table)} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning ${ident(returning)}`;
  const res = await db.query<Record<string, T>>(sql, params);
  return res.rows[0]![returning] as T;
}
