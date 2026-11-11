import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { stageNativeHostPackage } from '../lib/package.mjs';

function frameMsg(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const buf = Buffer.alloc(4 + payload.length);
  buf.writeUInt32LE(payload.length, 0);
  payload.copy(buf, 4);
  return buf;
}

function parseFrame(buf) {
  assert.ok(buf.length >= 4, 'Stdout missing 4-byte frame header');
  const len = buf.readUInt32LE(0);
  assert.equal(buf.length, len + 4);
  return JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
}

for (const browser of ['chrome', 'edge']) {
  for (const startVersion of [3, 4]) {
    test(`migration & boundary regression: ${browser} from schema v${startVersion}`, (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `nexus-test-${browser}-v${startVersion}-`)));
      t.after(() => rmSync(root, { recursive: true, force: true }));

      let pkgDir;
      if (process.env.NEXUS_TEST_HOST_PAYLOAD) {
        assert.ok(isAbsolute(process.env.NEXUS_TEST_HOST_PAYLOAD));
        pkgDir = realpathSync(process.env.NEXUS_TEST_HOST_PAYLOAD);
        assert.equal(JSON.parse(readFileSync(join(pkgDir, 'package-manifest.json'), 'utf8')).formatVersion, 1);
      } else {
        pkgDir = join(root, 'payload with spaces');
        stageNativeHostPackage({ outputDir: pkgDir, version: '0.3.0-dev.1' });
      }

      const home = join(root, 'home');
      const dbDir = join(home, '.config', 'nexus', 'logs');
      const dbPath = join(dbDir, 'observability.sqlite');
      assert.ok(dbPath.startsWith(home), 'databasePath must start with isolated HOME');
      mkdirSync(dbDir, { recursive: true });

      const migrationsDir = join(pkgDir, 'vendor', 'observability-store', 'migrations');
      const files = ['001_observability.sql', '002_legacy-import-receipts.sql', '003_store_meta.sql', '004_companion-activity.sql'];

      let db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (let v = 1; v <= startVersion; v++) {
        db.exec(readFileSync(join(migrationsDir, files[v - 1]), 'utf8'));
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
      }

      const now = Date.now();
      const isoNow = new Date(now).toISOString();
      db.prepare("INSERT INTO sessions (id, start_time) VALUES ('s1', ?)").run(isoNow);
      db.prepare("INSERT INTO tasks (id, session_id, timestamp, source, model, routing, ok) VALUES ('t1', 's1', ?, 'test', 'm1', 'direct', 1)").run(isoNow);
      db.prepare("INSERT INTO store_meta (key, value) VALUES ('legacy_jsonl_imported', '1')").run();

      if (startVersion === 4) {
        db.prepare("UPDATE companion_settings SET collection_enabled=1, raw_span_retention_days=365, updated_at=? WHERE id=1").run(isoNow);
        db.prepare("INSERT INTO companion_tool_consents (adapter_id, tool_id, enabled, consent_policy_version, updated_at) VALUES ('browser-chrome', 'chatgpt', 1, 1, ?)").run(isoNow);
        db.prepare(`INSERT INTO tool_activity (id, tool_id, surface, started_at, ended_at, detector, confidence, browser_family, platform, schema_version, consent_policy_version)
          VALUES ('act1', 'chatgpt', 'browser', ?, ?, 'selected-browser-tab', 'surface-active', 'chrome', 'linux', 1, 1)`).run(new Date(now - 3000).toISOString(), new Date(now - 2000).toISOString());
      }

      db.prepare("INSERT INTO legacy_import_receipts (source_path,snapshot_hash,raw_line_hash,occurrence,task_id,imported_at) VALUES ('fixture-source','snapshot','line',1,'t1',?)").run(isoNow);
      const snapReceipts = db.prepare('SELECT * FROM legacy_import_receipts').all();
      const snapSessions = db.prepare('SELECT * FROM sessions ORDER BY id').all();
      const snapTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
      const snapMeta = db.prepare('SELECT * FROM store_meta ORDER BY key').all();
      const snapConsents = startVersion === 4 ? db.prepare('SELECT * FROM companion_tool_consents ORDER BY adapter_id, tool_id').all() : null;
      const snapActivity = startVersion === 4 ? db.prepare('SELECT * FROM tool_activity ORDER BY id').all() : null;
      db.close();

      const runOpts = { env: { ...process.env, HOME: home, NODE_NO_WARNINGS: '1' }, timeout: 10000, maxBuffer: 65536 };
      const hostBin = join(pkgDir, 'apps', 'companion-native-host', 'bin', `nexus-companion-native-host-${browser}.mjs`);

      const originalBytes = readFileSync(dbPath);
      // The CLI-owned data helper is no longer staged: probe the old store
      // directly. A v3 store has no tool_activity table yet, so status-style
      // reads fail closed without touching the file; a v4 store reads fine.
      const probePre = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(probePre.prepare('SELECT MAX(version) as v FROM schema_migrations').get().v, startVersion);
        const tables = probePre.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_activity'").all();
        assert.equal(tables.length, startVersion === 3 ? 0 : 1);
        if (startVersion === 3) {
          assert.throws(() => probePre.prepare('SELECT COUNT(*) AS n FROM tool_activity').get());
        } else {
          assert.equal(probePre.prepare('SELECT COUNT(*) AS n FROM tool_activity').get().n, 1);
        }
      } finally { probePre.close(); }
      assert.deepEqual(readFileSync(dbPath), originalBytes);

      db = new DatabaseSync(dbPath, { readOnly: true });
      const preVersion = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get().v;
      assert.equal(preVersion, startVersion, 'Pre-status check must not change schema version');
      db.close();

      const hostRes = spawnSync(process.execPath, [hostBin], { ...runOpts, input: frameMsg({}) });
      assert.equal(hostRes.status, 0, `Host failed: ${hostRes.stderr}`);
      assert.equal(hostRes.stderr.length, 0);
      assert.deepEqual(parseFrame(hostRes.stdout), { schema_version: 1, ok: false });

      db = new DatabaseSync(dbPath, { readOnly: true });
      const postVersion = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get().v;
      assert.equal(postVersion, 5, 'Host must migrate database to version 5');
      assert.deepEqual(db.prepare('SELECT * FROM legacy_import_receipts').all(), snapReceipts);
      assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY id').all(), snapSessions);
      assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), snapTasks);
      assert.deepEqual(db.prepare('SELECT * FROM store_meta ORDER BY key').all(), snapMeta);
      if (startVersion === 4) {
        assert.deepEqual(db.prepare('SELECT * FROM companion_tool_consents ORDER BY adapter_id, tool_id').all(), snapConsents);
        assert.deepEqual(db.prepare('SELECT * FROM tool_activity ORDER BY id').all(), snapActivity);
      }
      assert.equal(db.prepare('SELECT COUNT(*) n FROM tool_activity').get().n, startVersion === 4 ? 1 : 0);
      const settings = db.prepare('SELECT * FROM companion_settings WHERE id = 1').get();
      assert.equal(settings.collection_enabled, 0);
      assert.equal(settings.collection_started_at, null);
      assert.equal(existsSync(join(home, '.config', 'google-chrome')), false);
      assert.equal(existsSync(join(home, '.config', 'microsoft-edge')), false);
      db.close();

      // The packaged vendored store must re-migrate idempotently and still
      // see the upgraded store as current, with collection paused by the 005
      // upgrade and history preserved.
      const resStorePost = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { createObservabilityStore } from './vendor/observability-store/lib/observability-store.mjs';
        import { DatabaseSync } from 'node:sqlite';
        import { join } from 'node:path';
        const databasePath = join(process.env.HOME, '.config/nexus/logs/observability.sqlite');
        createObservabilityStore({databasePath}).migrate();
        const db = new DatabaseSync(databasePath, {readOnly: true});
        try {
          if (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get().v !== 5) throw new Error('fixture_version_invalid');
          const settings = db.prepare('SELECT collection_enabled, collection_started_at FROM companion_settings WHERE id=1').get();
          if (settings.collection_enabled !== 0 || settings.collection_started_at !== null) throw new Error('fixture_settings_invalid');
        } finally { db.close(); }
      `], { ...runOpts, cwd: pkgDir });
      assert.equal(resStorePost.status, 0, 'Packaged vendored store must re-migrate idempotently post-upgrade');

      if (startVersion === 4) {
        const boundaryIso = new Date(Date.now() - 1000).toISOString();
        db = new DatabaseSync(dbPath);
        db.prepare('UPDATE companion_settings SET collection_enabled = 1, collection_started_at = ? WHERE id = 1').run(boundaryIso);
        db.close();

        const hostRes2 = spawnSync(process.execPath, [hostBin], { ...runOpts, input: frameMsg({}) });
        assert.equal(hostRes2.status, 0);
        assert.equal(hostRes2.stderr.length, 0);
        assert.deepEqual(parseFrame(hostRes2.stdout), {schema_version:1,ok:false});

        db = new DatabaseSync(dbPath, { readOnly: true });
        const post2 = db.prepare('SELECT * FROM companion_settings WHERE id = 1').get();
        assert.equal(post2.collection_enabled, 1);
        assert.equal(post2.collection_started_at, boundaryIso);
        db.close();
      }
    });
  }
}
