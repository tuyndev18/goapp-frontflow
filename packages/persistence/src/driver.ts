import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParams = Record<string, SqlValue>;
export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(params?: SqlParams | SqlValue[]): SqlRunResult;
  get<T = SqlRow>(params?: SqlParams | SqlValue[]): T | undefined;
  all<T = SqlRow>(params?: SqlParams | SqlValue[]): T[];
}

/**
 * Minimal synchronous SQL driver. Named parameters use `@name` in SQL and bare
 * keys in the params object (supported by node:sqlite and better-sqlite3 alike).
 */
export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs fn in a transaction; nested calls become savepoints. Rolls back on throw. */
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly isOpen: boolean;
}

export function createNodeSqliteDriver(filePath: string): SqlDriver {
  return new NodeSqliteDriver(new DatabaseSync(filePath));
}

class NodeSqliteDriver implements SqlDriver {
  private readonly cache = new Map<string, SqlStatement>();
  private depth = 0;
  private savepointSeq = 0;

  constructor(private readonly db: DatabaseSync) {}

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = wrapStatement(this.db.prepare(sql));
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.db.exec("BEGIN IMMEDIATE");
      this.depth++;
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      } finally {
        this.depth--;
      }
    }
    const name = `sp_${++this.savepointSeq}`;
    this.db.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.cache.clear();
    if (this.db.isOpen) this.db.close();
  }
}

function wrapStatement(stmt: StatementSync): SqlStatement {
  const call = <R>(fn: (...args: never[]) => R, params?: SqlParams | SqlValue[]): R => {
    if (params === undefined) return (fn as () => R).call(stmt);
    if (Array.isArray(params)) return (fn as (...a: SqlValue[]) => R).apply(stmt, params);
    return (fn as (p: SqlParams) => R).call(stmt, params);
  };
  return {
    run: (params) => call(stmt.run, params),
    get: <T>(params?: SqlParams | SqlValue[]) => call(stmt.get, params) as T | undefined,
    all: <T>(params?: SqlParams | SqlValue[]) => call(stmt.all, params) as T[],
  };
}
