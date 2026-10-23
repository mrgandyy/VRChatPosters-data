import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.js';
import { acceptsButtonPrefix, databasePath, LEGACY_BRAND, rebrand } from './branding.js';
import { catalog } from './publish.js';

test('legacy database migration preserves WAL data, channels, partner codes, submissions and releases', async () => {
  const dir = mkdtempSync(join(tmpdir(),'wreckshop-migration-'));
  const old = new Store(join(dir,`${LEGACY_BRAND.toLowerCase()}.sqlite`));
  let migrated: Store | undefined;
  try {
    old.db.prepare('UPDATE groups SET name=? WHERE id=0').run(`${LEGACY_BRAND} Worlds`);
    const partner = old.registerGroup('Partner','premium');
    old.addRepresentative(partner.id,'user');
    old.setSetting('submission_channel','123');
    old.setSetting('admin_role','456');
    const submission = old.submit(partner.id,1,'user','source','preview');
    old.decide(submission.id,'reviewer',true);
    old.recordRelease(partner.id,1,8,'a'.repeat(64),'https://example.test/unchanged.png');
    const path = await databasePath(dir);
    migrated = new Store(path);
    assert.equal(migrated.group(0)?.name,'Wreckshop Worlds');
    assert.equal(migrated.group(partner.id)?.code,partner.code);
    assert.equal(migrated.canRepresent(partner.id,'user'),true);
    assert.equal(migrated.setting('submission_channel'),'123');
    assert.equal(migrated.setting('admin_role'),'456');
    assert.equal(migrated.assigned(partner.id).get(1)?.id,submission.id);
    assert.equal(migrated.activeRelease(partner.id)?.publicUrl,'https://example.test/unchanged.png');
    migrated.setSetting('after_migration','keep');
    assert.equal(await databasePath(dir),path);
    assert.equal(migrated.setting('after_migration'),'keep');
    assert.ok(existsSync(join(dir,`${LEGACY_BRAND.toLowerCase()}.sqlite`)));
    const feed = JSON.parse(catalog(migrated).toString());
    assert.equal(feed.brand,'Wreckshop Worlds');
    assert.equal(feed.publisher,'TwerkTaco & Resolve');
  } finally { migrated?.close(); old.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('old review buttons keep working and branding replacements preserve case', () => {
  assert.ok(acceptsButtonPrefix('cw'));
  assert.ok(acceptsButtonPrefix('ws'));
  assert.equal(acceptsButtonPrefix('other'),false);
  assert.equal(rebrand(`${LEGACY_BRAND} Worlds`),'Wreckshop Worlds');
  assert.equal(rebrand(`${LEGACY_BRAND.toLowerCase()}-submit`),'wreckshop-submit');
  assert.equal(rebrand(LEGACY_BRAND.toUpperCase()),'WRECKSHOP');
});
