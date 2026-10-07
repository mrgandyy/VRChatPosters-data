import { initializeBackdrops } from './backdrop.js';
import { normalizeGroupLink, isGroupReference, validateGroupName } from './group-link.js';
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
        slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 32), submitter_id TEXT NOT NULL,
        source_path TEXT NOT NULL, preview_path TEXT NOT NULL,
        status TEXT NOT NULL, previous_id INTEGER REFERENCES submissions(id),
        reviewed_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS assignments (
        group_id INTEGER NOT NULL REFERENCES groups(id), slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 32),
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
    this.migratePosterCapacity(path);
    initializeBillboards(this);
    initializeBackdrops(this);
    const columns = this.db.prepare('PRAGMA table_info(groups)').all() as { name:string }[];
    if(path!==':memory:' && !columns.some(column=>column.name==='deleted'))
      this.db.prepare('VACUUM INTO ?').run(`${path}.before-group-management-${Date.now()}.sqlite`);
    if (!columns.some(column => column.name === 'agreement_by'))
      this.db.exec('ALTER TABLE groups ADD COLUMN agreement_by TEXT');
    if (!columns.some(column => column.name === 'deleted'))
      this.db.exec('ALTER TABLE groups ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
    this.db.prepare("UPDATE jobs SET status='queued' WHERE status='publishing'").run();
    this.db.prepare(`INSERT OR IGNORE INTO groups(id,name,tier,code,enabled,atlas_slot)
      VALUES(0,'Wreckshop Worlds','premium','00000000',1,0)`).run();
    this.db.prepare('UPDATE groups SET name=? WHERE id=0 AND lower(name)=lower(?)')
      .run('Wreckshop Worlds',`${LEGACY_BRAND} Worlds`);
    this.cleanupDuplicates();
  }

  private migratePosterCapacity(path: string): void {
    const tables = this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('submissions','assignments')")
      .all() as {name:string;sql:string}[];
    const old = tables.filter(t => /slot BETWEEN 1 AND 16/i.test(t.sql));
    if (!old.length) return;
    if (path !== ':memory:') this.db.prepare('VACUUM INTO ?').run(`${path}.before-32-posters-${Date.now()}.sqlite`);
    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        for (const table of old) {
          const extras = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table.name) as {sql:string}[];
          const create = table.sql.replace(new RegExp(`CREATE TABLE ["\x60]?${table.name}["\x60]?`, 'i'), `CREATE TABLE ${table.name}_32`)
            .replace(/slot BETWEEN 1 AND 16/gi, 'slot BETWEEN 1 AND 32');
          this.db.exec(create);
          this.db.exec(`INSERT INTO ${table.name}_32 SELECT * FROM ${table.name}; DROP TABLE ${table.name}; ALTER TABLE ${table.name}_32 RENAME TO ${table.name};`);
          for (const extra of extras) this.db.exec(extra.sql);
        }
        if ((this.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Poster migration failed foreign key validation.');
      })();
    } finally { this.db.pragma('foreign_keys = ON'); }
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
      atlas_slot AS atlasSlot,revision FROM groups WHERE id=? AND deleted=0`).get(id) as Group | undefined;
  }
  groupByCode(code: string): Group | undefined {
    return this.db.prepare(`SELECT id,name,tier,code,enabled,vrchat_url AS vrchatUrl,
      agreement_version AS agreementVersion,agreement_at AS agreementAt,
      atlas_slot AS atlasSlot,revision FROM groups WHERE code=? AND deleted=0`).get(code) as Group | undefined;
  }
  groups(): Group[] {
    return this.db.prepare(`SELECT id,name,tier,code,enabled,vrchat_url AS vrchatUrl,
      agreement_version AS agreementVersion,agreement_at AS agreementAt,
      atlas_slot AS atlasSlot,revision FROM groups WHERE deleted=0 ORDER BY id`).all() as Group[];
  }
  registerGroup(name: string, tier: Tier = 'standard', vrchatGroup?: string, userId?: string): Group {
    return this.db.transaction(() => {
    const vrchatUrl = vrchatGroup === undefined ? null : normalizeGroupLink(vrchatGroup);
    name=validateGroupName(name);
    const existing = vrchatUrl ? this.groups().find(g => g.vrchatUrl === vrchatUrl) : undefined;
    if (existing) {
      if (!userId || !this.canRepresent(existing.id,userId)) throw new Error(`This VRChat group is already registered as #${existing.id}. Ask its representative or an admin for access.`);
      return this.group(existing.id)!;
    }
    const represented=userId ? this.representedGroups(userId)[0] : undefined;
    if (represented) {
      if(!vrchatUrl && represented.name.trim().toLowerCase()===name.trim().toLowerCase()) return represented;
      throw new Error(`You already represent group #${represented.id}. Rename or delete it instead of registering another.`);
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number };
    if (count.n >= 32) throw new Error('Authored atlas URL capacity is 32 groups.');
    let code = '';
    do { code = randomInt(0, 100_000_000).toString().padStart(8, '0'); }
    while (this.db.prepare('SELECT 1 FROM groups WHERE code=?').get(code));
    const slot = count.n;
    const id = Number(this.db.prepare(`INSERT INTO groups(name,tier,code,atlas_slot,vrchat_url)
      VALUES(?,?,?,?,?)`).run(name.trim(), tier, code, slot,vrchatUrl).lastInsertRowid);
    if (userId) this.addRepresentative(id,userId);
    return this.group(id)!;
    })();
  }
  renameGroup(id: number, name: string): void {
    if (id === 0 || !this.group(id)) throw new Error('Group cannot be renamed.');
    name=validateGroupName(name);
    this.db.prepare('UPDATE groups SET name=? WHERE id=?').run(name.trim(),id);
    this.queuePublish(id);
  }
  deleteGroup(id: number): void {
    if (id === 0 || !this.group(id)) throw new Error('Group cannot be deleted.');
    this.db.transaction(() => {
      this.db.prepare('UPDATE groups SET deleted=1,enabled=0 WHERE id=?').run(id);
      this.db.prepare('DELETE FROM representatives WHERE group_id=?').run(id);
      this.db.prepare("UPDATE jobs SET status='cancelled' WHERE group_id=? AND status IN ('queued','publishing','failed')").run(id);
      this.queuePublish(0);
    })();
  }
  cleanupDuplicates(): number {
    return this.db.transaction(() => {
      let removed=0;
      for(const g of this.groups()) if(g.id!==0 && !g.vrchatUrl && isGroupReference(g.name)) {
        try {const url=normalizeGroupLink(g.name);this.db.prepare('UPDATE groups SET vrchat_url=? WHERE id=?').run(url,g.id);}
        catch { /* malformed historical text requires manual correction */ }
      }
      // Prefer premium/artwork, then linked/represented entries, then oldest ID.
      const rows=this.groups().filter(g=>g.id!==0).sort((a,b)=>
        Number(b.tier==='premium')-Number(a.tier==='premium') || this.assigned(b.id).size-this.assigned(a.id).size ||
        Number(!!b.vrchatUrl)-Number(!!a.vrchatUrl) || Number(this.hasRepresentatives(b.id))-Number(this.hasRepresentatives(a.id)) || a.id-b.id);
      const kept: Group[]=[];
      for (const g of rows) {
        const same=kept.find(k=> (g.vrchatUrl && g.vrchatUrl===k.vrchatUrl) ||
          ((!g.vrchatUrl || !k.vrchatUrl) && g.name.trim().toLowerCase()===k.name.trim().toLowerCase() &&
            (!!this.db.prepare('SELECT 1 FROM representatives a JOIN representatives b ON a.user_id=b.user_id WHERE a.group_id=? AND b.group_id=?').get(g.id,k.id) ||
              (!g.vrchatUrl && !this.hasRepresentatives(g.id) && this.assigned(g.id).size===0 && this.submissions(g.id).length===0))));
        if (!same) {kept.push(g); continue;}
        // Archive duplicate artwork/history intact; migrate only nonconflicting representatives.
        this.db.prepare('INSERT OR IGNORE INTO representatives(group_id,user_id) SELECT ?,user_id FROM representatives WHERE group_id=?').run(same.id,g.id);
        this.setSetting(`duplicate-group-${g.id}`,JSON.stringify({canonicalId:same.id,name:g.name,archivedAt:new Date().toISOString()}));
        this.deleteGroup(g.id); removed++;
      }
      const reps=this.db.prepare('SELECT user_id,group_id FROM representatives ORDER BY group_id').all() as {user_id:string;group_id:number}[];
      const seen=new Set<string>();
      for(const r of reps) {
        if(seen.has(r.user_id)) {this.removeRepresentative(r.group_id,r.user_id); removed++;}
        else seen.add(r.user_id);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS one_group_per_discord_user ON representatives(user_id); CREATE UNIQUE INDEX IF NOT EXISTS one_vrchat_group ON groups(vrchat_url) WHERE deleted=0 AND vrchat_url IS NOT NULL');
      if(removed) this.queuePublish(0);
      return removed;
    })();
  }
  private hasRepresentatives(id:number): boolean {
    return !!this.db.prepare('SELECT 1 FROM representatives WHERE group_id=? LIMIT 1').get(id);
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
    if (url && this.groups().some(g=>g.id!==groupId && g.vrchatUrl===url)) throw new Error('That VRChat group is already registered.');
    this.db.prepare('UPDATE groups SET vrchat_url=? WHERE id=?').run(url, groupId);
    this.queuePublish(groupId);
  }
  acceptAgreement(groupId: number, version: string, userId: string): void {
    this.db.prepare(`UPDATE groups SET agreement_version=?,agreement_at=CURRENT_TIMESTAMP,agreement_by=? WHERE id=?`)
      .run(version, userId, groupId);
  }
  addRepresentative(groupId: number, userId: string): void {
    if (!this.group(groupId)) throw new Error('Group is unavailable.');
    const existing=this.representedGroups(userId).find(g=>g.id!==groupId);
    if(existing) throw new Error(`This Discord user already represents group #${existing.id}. Remove that assignment first.`);
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
    // Fresh approvals take priority. Retry only the latest failed job for a group,
    // with a cooldown and a finite budget; never replay superseded publications.
    return this.db.prepare(`SELECT id,group_id AS groupId,attempts FROM jobs j
      WHERE status='queued' OR (
        status='failed' AND attempts < 3
        AND updated_at <= datetime('now','-2 minutes')
        AND id=(SELECT MAX(id) FROM jobs WHERE group_id=j.group_id)
        AND EXISTS (SELECT 1 FROM groups WHERE id=j.group_id AND deleted=0)
        AND (error LIKE '%Public asset did not match the release hash:%'
          OR error LIKE '%GitHub%failed: HTTP 5%'
          OR error LIKE '%GitHub%failed: HTTP 429%'
          OR error LIKE '%fetch failed%'
          OR error LIKE '%TimeoutError:%'))
      ORDER BY CASE WHEN status='queued' THEN 0 ELSE 1 END,id LIMIT 1`)
      .get() as { id: number; groupId: number; attempts: number } | undefined;
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
