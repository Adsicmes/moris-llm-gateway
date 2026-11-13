import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoWeek, runBackup, shanghaiDate } from '../scripts/backup.js';

const DAY = 86_400_000;
const DAILY_RE = /^moris-daily-\d{4}-\d{2}-\d{2}\.sqlite$/;
const WEEKLY_RE = /^moris-weekly-\d{4}-W\d{2}\.sqlite$/;

async function workspace(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moris-backup-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function createDatabase(path: string, rows = 32): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  `);
  const insert = db.prepare('INSERT INTO messages(body) VALUES (?)');
  for (let i = 0; i < rows; i += 1) insert.run(`row-${i}`);
  return db;
}

test('在线备份包含 WAL 中已提交的数据且通过完整性检查', async (t) => {
  const dir = await workspace(t);
  const dbPath = join(dir, 'moris.sqlite');
  const backupDir = join(dir, 'backups');
  const db = createDatabase(dbPath, 50);

  // 保持原连接打开：此时数据仍在 WAL，直接复制主文件会漏数据。
  const result = await runBackup(dbPath, backupDir, new Date('2026-11-13T00:00:00Z'));
  db.close();

  assert.match(result.daily, /moris-daily-2026-11-13\.sqlite$/);

  const copy = new DatabaseSync(result.daily, { readOnly: true });
  try {
    const count = copy.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
    assert.equal(count.n, 50);
    const integrity = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, 'ok');
  } finally {
    copy.close();
  }

  // 备份必须是自包含文件：只读校验不应留下 -wal/-shm 旁文件。
  const files = await readdir(backupDir);
  assert.deepEqual(files.filter((name) => name.endsWith('-wal') || name.endsWith('-shm')), []);

  if (process.platform !== 'win32') {
    assert.equal((await stat(result.daily)).mode & 0o777, 0o600);
    assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
  }
});

test('日备份保留 7 份、周备份保留 4 份，且本周只建一份', async (t) => {
  const dir = await workspace(t);
  const dbPath = join(dir, 'moris.sqlite');
  const backupDir = join(dir, 'backups');
  const db = createDatabase(dbPath, 3);

  const start = Date.UTC(2026, 0, 5, 4, 0, 0); // 2026-01-05 是周一
  let weeklyCreated = 0;
  for (let i = 0; i < 42; i += 1) {
    const result = await runBackup(dbPath, backupDir, new Date(start + i * DAY));
    if (result.weekly) weeklyCreated += 1;
  }
  db.close();

  const files = await readdir(backupDir);
  const daily = files.filter((name) => DAILY_RE.test(name)).sort();
  const weekly = files.filter((name) => WEEKLY_RE.test(name)).sort();

  assert.equal(daily.length, 7);
  assert.deepEqual(daily, [
    'moris-daily-2026-02-09.sqlite',
    'moris-daily-2026-02-10.sqlite',
    'moris-daily-2026-02-11.sqlite',
    'moris-daily-2026-02-12.sqlite',
    'moris-daily-2026-02-13.sqlite',
    'moris-daily-2026-02-14.sqlite',
    'moris-daily-2026-02-15.sqlite',
  ]);
  assert.equal(weekly.length, 4);
  assert.equal(weeklyCreated, 6);

  // 同一天再次运行不应覆盖本周第一份周备份。
  const again = await runBackup(dbPath, backupDir, new Date(start + 41 * DAY));
  assert.equal(again.weekly, null);
});

test('轮转只删除自己的日/周备份，不碰其他文件', async (t) => {
  const dir = await workspace(t);
  const dbPath = join(dir, 'moris.sqlite');
  const backupDir = join(dir, 'backups');
  const db = createDatabase(dbPath, 1);
  db.close();

  const foreign = [
    'notes.txt',
    'moris-daily-2020-01-01.sqlite.bak',
    'moris-weekly-2020-W01.sqlite.tmp',
    'other.sqlite',
  ];
  await runBackup(dbPath, backupDir, new Date('2026-03-02T04:00:00Z'));
  for (const name of foreign) await writeFile(join(backupDir, name), 'keep');

  const start = Date.UTC(2026, 2, 3, 4, 0, 0);
  for (let i = 0; i < 10; i += 1) {
    await runBackup(dbPath, backupDir, new Date(start + i * DAY));
  }

  const files = await readdir(backupDir);
  for (const name of foreign) assert.ok(files.includes(name), `${name} 不应被删除`);
  assert.equal(files.filter((name) => DAILY_RE.test(name)).length, 7);
  assert.ok(files.filter((name) => WEEKLY_RE.test(name)).length <= 4);
});

test('数据库不存在时拒绝并给出明确错误', async (t) => {
  const dir = await workspace(t);
  await assert.rejects(
    () => runBackup(join(dir, 'missing.sqlite'), join(dir, 'backups')),
    /数据库不存在/,
  );
});

test('ISO 周与上海日期在跨年边界正确', () => {
  assert.deepEqual(shanghaiDate(new Date('2026-11-12T16:30:00Z')), {
    year: 2026,
    month: 11,
    day: 13,
  });
  assert.deepEqual(isoWeek(new Date('2025-12-28T16:30:00Z')), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek(new Date('2026-01-04T16:30:00Z')), { year: 2026, week: 2 });
});
