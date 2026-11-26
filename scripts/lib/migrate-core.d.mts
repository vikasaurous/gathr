export interface MigrationFile {
  filename: string;
  number: number;
  checksum: string;
  statements: string[];
}
export interface MigrationPlan {
  pending: MigrationFile[];
  applied: MigrationFile[];
  problems: string[];
}
export interface MigrationDb {
  ensureLog(): Promise<void>;
  getApplied(): Promise<Map<string, string>>;
  applyMigration(input: {
    filename: string;
    checksum: string;
    statements: string[];
  }): Promise<void>;
}
export const LEDGER_TABLE_SQL: string;
export const MIGRATION_LOCK_KEY: number;
export function normalizeSql(content: string): string;
export function checksum(content: string): string;
export function splitStatements(content: string): string[];
export function discoverMigrations(dir: string): MigrationFile[];
export function planMigrations(files: MigrationFile[], applied: Map<string, string>): MigrationPlan;
export function runMigrations(options: {
  db: MigrationDb;
  dir: string;
  mode?: "status" | "dry-run" | "apply";
  log?: (message: string) => void;
}): Promise<MigrationPlan & { appliedNow: string[]; ok: boolean }>;
