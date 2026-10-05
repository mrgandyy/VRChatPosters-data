import { initializeBackdrops } from './backdrop.js';
import { normalizeGroupLink } from './group-link.js';
import Database from 'better-sqlite3';
import { initializeBillboards } from './billboard.js';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertSlot, type Group, type Submission, type Tier } from './types.js';
import { LEGACY_BRAND } from './branding.js';

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('standard','premium')),
        code TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
        vrchat_url TEXT, agreement_version TEXT, agreement_at TEXT, agreement_by TEXT,
        atlas_slot INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS representatives (
        group_id INTEGER NOT NULL REFERENCES groups(id), user_id TEXT NOT NULL,
        PRIMARY KEY(group_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id),
        slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 16), submitter_id TEXT NOT NULL,
        source_path TEXT NOT NULL, preview_path TEXT NOT NULL,
        status TEXT NOT NULL, previous_id INTEGER REFERENCES submissions(id),
        reviewed_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS assignments (
        group_id INTEGER NOT NULL REFERENCES groups(id), slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 16),
        submission_id INTEGER NOT NULL REFERENCES submissions(id), PRIMARY KEY(group_id,slot)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id),
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id),
        revision INTEGER NOT NULL, pool_index INTEGER NOT NULL,
        sha256 TEXT NOT NULL, public_url TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id,revision)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    initializeBillboards(this);
    initializeBackdrops(this);
    const columns = this.db.prepare('PRAGMA table_info(groups)').all() as { name:string }[];
    if (!columns.some(column => column.name === 'agreement_by'))
      this.db.exec('ALTER TABLE groups ADD COLUMN agreement_by TEXT');
    this.db.prepare("UPDATE jobs SET status='queued' WHERE status='publishing'").run();
    this.db.prepare(`INSERT OR IGNORE INTO groups(id,name,tier,code,enabled,atlas_slot)
      VALUES(0,'Wreckshop Worlds','premium','00000000',1,0)`).run();
    this.db.prepare('UPDATE groups SET name=? WHERE id=0 AND lower(name)=lower(?)')
      .run('Wreckshop Worlds',`${LEGACY_BRAND} Worlds`);
  }

  close(): void { this.db.close(); }
  setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  }
  group(id: number): Group | undefined {
    return this.db.prepare(`SELECT id,name,tier,code,enabled,vrchat_url AS vrchatUrl,
      agreement_version AS agreementVersion,agreement_at AS agreementAt,
      atlas_slot AS atlasSlot,revision FROM groups WHERE id=?`).get(id) as Group | undefined;
  }
  groupByCode(code: string): Group | undefined {
    return this.db.prepare(`SELECT id,name,tier,code,enabled,vrchat_url AS vrchatUrl,
      agreement_version AS agreementVersion,agreement_at AS agreementAt,
      atlas_slot AS atlasSlot,revision FROM groups WHERE code=?`).get(code) as Group | undefined;
  }
  groups(): Group[] {
    return this.db.prepare(`SELECT id,name,tier,code,enabled,vrchat_url AS vrchatUrl,
      agreement_version AS agreementVersion,agreement_at AS agreementAt,
      atlas_slot AS atlasSlot,revision FROM groups ORDER BY id`).all() as Group[];
  }
  registerGroup(name: string, tier: Tier = 'standard', vrchatGroup?: string): Group {
    const vrchatUrl = vrchatGroup === undefined ? null : normalizeGroupLink(vrchatGroup);
    if (!name.trim() || name.length > 80) throw new Error('Group name must be 1–80 characters.');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number };
    if (count.n >= 32) throw new Error('Authored atlas URL capacity is 32 groups.');
    let code = '';
    do { code = randomInt(0, 100_000_000).toString().padStart(8, '0'); }
    while (this.groupByCode(code));
    const slot = count.n;
    const id = Number(this.db.prepare(`INSERT INTO groups(name,tier,code,atlas_slot,vrchat_url)
      VALUES(?,?,?,?,?)`).run(name.trim(), tier, code, slot,vrchatUrl).lastInsertRowid);
    return this.group(id)!;
  }
  setTier(groupId: number, tier: Tier): void {
    if (groupId === 0) throw new Error('Default configuration stays premium.');
    this.db.transaction(() => {
      this.db.prepare('UPDATE groups SET tier=? WHERE id=?').run(tier, groupId);
      if (tier === 'standard') {
        this.db.prepare('DELETE FROM assignments WHERE group_id=? AND slot>8').run(groupId);
      }
      this.queuePublish(groupId);
    })();
  }
  setCode(groupId: number, code: string): void {
    if (groupId === 0) throw new Error('Default code is fixed.');
    if (!/^\d{8}$/.test(code)) throw new Error('Code must contain exactly eight digits.');
    this.db.prepare('UPDATE groups SET code=? WHERE id=?').run(code, groupId);
    this.queuePublish(groupId);
  }
  setEnabled(groupId: number, enabled: boolean): void {
    if (groupId === 0) throw new Error('Default configuration cannot be suspended.');
    this.db.prepare('UPDATE groups SET enabled=? WHERE id=?').run(enabled ? 1 : 0, groupId);
    this.queuePublish(groupId);
  }
  setUrl(groupId: number, url: string | null): void {
    if (url !== null) url = normalizeGroupLink(url);
    this.db.prepare('UPDATE groups SET vrchat_url=? WHERE id=?').run(url, groupId);
    this.queuePublish(groupId);
  }
  acceptAgreement(groupId: number, version: string, userId: string): void {
    this.db.prepare(`UPDATE groups SET agreement_version=?,agreement_at=CURRENT_TIMESTAMP,agreement_by=? WHERE id=?`)
      .run(version, userId, groupId);
  }
  addRepresentative(groupId: number, userId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO representatives(group_id,user_id) VALUES(?,?)').run(groupId,userId);
  }
  removeRepresentative(groupId: number, userId: string): void {
    this.db.prepare('DELETE FROM representatives WHERE group_id=? AND user_id=?').run(groupId,userId);
  }
  representedGroups(userId: string): Group[] {
    return this.db.prepare(`SELECT g.id,g.name,g.tier,g.code,g.enabled,g.vrchat_url AS vrchatUrl,
      g.agreement_version AS agreementVersion,g.agreement_at AS agreementAt,
      g.atlas_slot AS atlasSlot,g.revision FROM groups g
      JOIN representatives r ON r.group_id=g.id WHERE r.user_id=? ORDER BY g.name`).all(userId) as Group[];
  }
  canRepresent(groupId: number, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM representatives WHERE group_id=? AND user_id=?').get(groupId,userId);
  }
  submission(id: number): Submission | undefined {
    return this.db.prepare(`SELECT id,group_id AS groupId,slot,submitter_id AS submitterId,
      source_path AS sourcePath,preview_path AS previewPath,status,previous_id AS previousId,
      reviewed_by AS reviewedBy,created_at AS createdAt FROM submissions WHERE id=?`).get(id) as Submission | undefined;
  }
  submissions(groupId: number): Submission[] {
    return this.db.prepare(`SELECT id,group_id AS groupId,slot,submitter_id AS submitterId,
      source_path AS sourcePath,preview_path AS previewPath,status,previous_id AS previousId,
      reviewed_by AS reviewedBy,created_at AS createdAt FROM submissions WHERE group_id=? ORDER BY id DESC`)
      .all(groupId) as Submission[];
  }
  assigned(groupId: number): Map<number, Submission> {
    const rows = this.db.prepare(`SELECT s.id,s.group_id AS groupId,s.slot,s.submitter_id AS submitterId,
      s.source_path AS sourcePath,s.preview_path AS previewPath,s.status,
      s.previous_id AS previousId,s.reviewed_by AS reviewedBy,s.created_at AS createdAt
      FROM assignments a JOIN submissions s ON s.id=a.submission_id WHERE a.group_id=?`)
      .all(groupId) as Submission[];
    return new Map(rows.map(row => [row.slot,row]));
  }
  submit(groupId: number, slot: number, userId: string, sourcePath: string, previewPath: string): Submission {
    const group = this.group(groupId);
    if (!group || !group.enabled) throw new Error('Group is unavailable.');
    assertSlot(group.tier,slot);
    const prior = this.db.prepare('SELECT submission_id AS id FROM assignments WHERE group_id=? AND slot=?')
      .get(groupId,slot) as { id: number } | undefined;
    const id = Number(this.db.prepare(`INSERT INTO submissions
      (group_id,slot,submitter_id,source_path,preview_path,status,previous_id)
      VALUES(?,?,?,?,?,'submitted',?)`).run(groupId,slot,userId,sourcePath,previewPath,prior?.id ?? null).lastInsertRowid);
    return this.submission(id)!;
  }
  decide(id: number, reviewerId: string, approve: boolean): Submission {
    return this.db.transaction(() => {
      const submission = this.submission(id);
      if (!submission || submission.status !== 'submitted') throw new Error('Submission was already reviewed or is missing.');
      const group = this.group(submission.groupId)!;
      assertSlot(group.tier,submission.slot);
      this.db.prepare(`UPDATE submissions SET status=?,reviewed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(approve ? 'approved' : 'rejected',reviewerId,id);
      if (approve) {
        this.db.prepare(`INSERT INTO assignments(group_id,slot,submission_id) VALUES(?,?,?)
          ON CONFLICT(group_id,slot) DO UPDATE SET submission_id=excluded.submission_id`)
          .run(submission.groupId,submission.slot,id);
        this.queuePublish(submission.groupId);
      }
      return this.submission(id)!;
    })();
  }
  removeOverride(groupId: number, slot: number): void {
    const group = this.group(groupId);
    if (!group) throw new Error('Group not found.');
    assertSlot(group.tier,slot);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM assignments WHERE group_id=? AND slot=?').run(groupId,slot);
      this.queuePublish(groupId);
    })();
  }
  queuePublish(groupId: number): number {
    const existing = this.db.prepare("SELECT id FROM jobs WHERE group_id=? AND status='queued' ORDER BY id LIMIT 1")
      .get(groupId) as { id: number } | undefined;
    if (existing) return existing.id;
    return Number(this.db.prepare("INSERT INTO jobs(group_id,status) VALUES(?,'queued')")
      .run(groupId).lastInsertRowid);
  }
  nextJob(): { id: number; groupId: number; attempts: number } | undefined {
    return this.db.prepare(`SELECT id,group_id AS groupId,attempts FROM jobs
      WHERE status='queued' ORDER BY id LIMIT 1`).get() as { id: number; groupId: number; attempts: number } | undefined;
  }
  markJob(id: number, status: string, error: string | null = null): void {
    this.db.prepare(`UPDATE jobs SET status=?,error=?,updated_at=CURRENT_TIMESTAMP,
      attempts=attempts+CASE WHEN ?='publishing' THEN 1 ELSE 0 END WHERE id=?`)
      .run(status,error,status,id);
  }
  recordRelease(groupId: number, revision: number, poolIndex: number, sha: string, url: string): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO releases(group_id,revision,pool_index,sha256,public_url)
        VALUES(?,?,?,?,?)`).run(groupId,revision,poolIndex,sha,url);
      this.db.prepare('UPDATE groups SET revision=? WHERE id=?').run(revision,groupId);
    })();
  }
  lastRelease(groupId: number): { revision: number; poolIndex: number; sha256: string; publicUrl: string } | undefined {
    return this.db.prepare(`SELECT revision,pool_index AS poolIndex,sha256,public_url AS publicUrl
      FROM releases WHERE group_id=? ORDER BY revision DESC LIMIT 1`).get(groupId) as
      { revision: number; poolIndex: number; sha256: string; publicUrl: string } | undefined;
  }
  activeRelease(groupId: number): { revision: number; poolIndex: number; sha256: string; publicUrl: string } | undefined {
    const group = this.group(groupId);
    return group ? this.release(groupId,group.revision) : undefined;
  }
  release(groupId: number, revision: number): { revision: number; poolIndex: number; sha256: string; publicUrl: string } | undefined {
    return this.db.prepare(`SELECT revision,pool_index AS poolIndex,sha256,public_url AS publicUrl
      FROM releases WHERE group_id=? AND revision=?`).get(groupId,revision) as
      { revision: number; poolIndex: number; sha256: string; publicUrl: string } | undefined;
  }
  revert(groupId: number, revision: number): void {
    const target = this.release(groupId,revision);
    if (!target) throw new Error('Release not found.');
    this.db.prepare('UPDATE groups SET revision=? WHERE id=?').run(revision,groupId);
  }
}
