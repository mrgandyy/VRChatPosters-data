import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Compatibility is isolated here so existing installations and pending buttons survive the rename.
export const LEGACY_BRAND = 'ChainWreck';
export function rebrand(value: string): string {
  return value.replace(/chainwreck/gi, match => match === match.toUpperCase() ? 'WRECKSHOP' :
    match === match.toLowerCase() ? 'wreckshop' : 'Wreckshop');
}
export function legacyName(value: string): string { return value.replace(/Wreckshop/g,LEGACY_BRAND).replace(/wreckshop/g,LEGACY_BRAND.toLowerCase()); }
export function acceptsButtonPrefix(prefix: string | undefined): boolean { return prefix === 'ws' || prefix === 'cw'; }

export async function databasePath(dataDir: string): Promise<string> {
  mkdirSync(dataDir,{recursive:true});
  const current = join(dataDir,'wreckshop.sqlite');
  const legacy = join(dataDir,`${LEGACY_BRAND.toLowerCase()}.sqlite`);
  if (!existsSync(current) && existsSync(legacy)) {
    // SQLite backup includes committed WAL pages. Publish the new filename only after success.
    const old = new Database(legacy,{readonly:true,fileMustExist:true});
    try { await old.backup(`${current}.migrating`); }
    finally { old.close(); }
    renameSync(`${current}.migrating`,current);
  }
  return current;
}
