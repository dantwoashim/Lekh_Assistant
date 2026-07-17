export type SqlitePrimitive = string | number | bigint | null;

export interface SQLiteStatement {
  all(...params: SqlitePrimitive[]): unknown[];
  get(...params: SqlitePrimitive[]): unknown;
  run(...params: SqlitePrimitive[]): unknown;
}

export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
}

export interface SQLiteModule {
  DatabaseSync: new (path: string) => SQLiteDatabase;
}

export interface SQLiteRow {
  [key: string]: unknown;
}
