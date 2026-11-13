/**
 * 在线一致性备份。
 *
 * 设计约束：
 * - 只用 node:sqlite 的 backup()，严禁复制 .sqlite 文件；直接复制会漏掉 WAL。
 * - 日备份保留 7 份，周备份保留 4 份；ISO 周按 Asia/Shanghai 日历确定。
 * - 只清理本脚本生成、且严格匹配文件名模式的文件，绝不碰其他文件。
 * - 备份文件 0600，目录 0700。
 *
 * 主进程可直接调用：
 *   import { runBackup } from '../../../scripts/backup.js';
 * apps/gateway/src/main.ts 与编译后的 dist/apps/gateway/src/main.js
 * 到 scripts/backup.ts 与 dist/scripts/backup.js 的相对层级相同，都是 ../../../。
 *
 * 命令行：
 *   node dist/scripts/backup.js [--db <sqlite路径>] [--backups <备份目录>]
 */

import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAILY_KEEP = 7;
const WEEKLY_KEEP = 4;
const DAILY_RE = /^moris-daily-(\d{4})-(\d{2})-(\d{2})\.sqlite$/;
const WEEKLY_RE = /^moris-weekly-(\d{4})-W(\d{2})\.sqlite$/;
const SHANGHAI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface BackupResult {
  /** 本次生成的日备份绝对路径。 */
  daily: string;
  /** 本周首次运行时生成的周备份；本周已有则返回 null。 */
  weekly: string | null;
  /** 本轮轮转删除的文件名。 */
  removed: string[];
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 按 Asia/Shanghai 日历取日期，避免凌晨运行落到 UTC 前一天。 */
export function shanghaiDate(now: Date): CalendarDate {
  const parts: Record<string, number> = {};
  for (const part of SHANGHAI_DATE.formatToParts(now)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      parts[part.type] = Number(part.value);
    }
  }
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('无法计算 Asia/Shanghai 日期');
  }
  return { year, month, day };
}

/** ISO 8601 周编号；跨年周按 ISO 规则归入正确年份。 */
export function isoWeek(now: Date): { year: number; week: number } {
  const { year, month, day } = shanghaiDate(now);
  const date = Date.UTC(year, month - 1, day);
  const weekday = new Date(date).getUTCDay() || 7;
  const thursday = new Date(date + (4 - weekday) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // Windows 上 chmod 语义有限，失败不阻塞备份。
  await chmod(path, 0o700).catch(() => undefined);
}

async function writeConsistentBackup(db: DatabaseSync, target: string): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await backup(db, temp);
    finalizeBackupFile(temp);
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * 把备份文件切到 DELETE 日志模式。
 * 备份是独立快照，不应再依赖 -wal/-shm；否则只读校验或拷贝时容易漏文件。
 */
export function finalizeBackupFile(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE;');
  } finally {
    db.close();
  }
}

async function rotate(
  backupDir: string,
  pattern: RegExp,
  keep: number,
): Promise<string[]> {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    // 文件名补零后可安全按字典序倒排（日期与 ISO 周均同构）。
    .sort()
    .reverse();

  const removed: string[] = [];
  for (const name of names.slice(keep)) {
    await unlink(join(backupDir, name));
    removed.push(name);
  }
  return removed;
}

/**
 * 执行一次在线备份并按日/周轮转。
 *
 * @param dbPath 现有 SQLite 数据库路径；不存在时报错，不会创建空库。
 * @param backupDir 备份目录；不存在时创建。
 * @param now 便于测试与定时任务注入当前时间。
 */
export async function runBackup(
  dbPath: string,
  backupDir: string,
  now: Date = new Date(),
): Promise<BackupResult> {
  const source = resolve(dbPath);
  const targetDir = resolve(backupDir);

  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`数据库不存在或不是文件: ${source}`);
  }

  await ensureDirectory(targetDir);

  const calendar = shanghaiDate(now);
  const dailyName = `moris-daily-${calendar.year}-${pad(calendar.month)}-${pad(calendar.day)}.sqlite`;
  const dailyPath = join(targetDir, dailyName);

  const iso = isoWeek(now);
  const weeklyName = `moris-weekly-${iso.year}-W${pad(iso.week)}.sqlite`;
  const weeklyPath = join(targetDir, weeklyName);

  const db = new DatabaseSync(source);
  try {
    await writeConsistentBackup(db, dailyPath);

    // 每周第一次运行生成一份周备份；已有则保留本周第一份。
    let createdWeekly: string | null = null;
    const weeklyExists = await stat(weeklyPath).then(() => true, () => false);
    if (!weeklyExists) {
      await writeConsistentBackup(db, weeklyPath);
      createdWeekly = weeklyPath;
    }

    const removedDaily = await rotate(targetDir, DAILY_RE, DAILY_KEEP);
    const removedWeekly = await rotate(targetDir, WEEKLY_RE, WEEKLY_KEEP);

    return {
      daily: dailyPath,
      weekly: createdWeekly,
      removed: [...removedDaily, ...removedWeekly],
    };
  } finally {
    db.close();
  }
}

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} 缺少参数值`);
  }
  return [value, index + 1];
}

function defaults(): { dbPath: string; backupDir: string } {
  const dataDir = process.env.MORIS_DATA_DIR ?? 'data';
  return {
    dbPath: join(dataDir, 'moris.sqlite'),
    backupDir: join(process.cwd(), 'backups'),
  };
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node dist/scripts/backup.js [--db <sqlite路径>] [--backups <备份目录>]');
    return;
  }

  const fallback = defaults();
  let dbPath = fallback.dbPath;
  let backupDir = fallback.backupDir;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) throw new Error('参数解析失败');
    if (arg === '--db') {
      [dbPath, i] = takeValue(argv, i, '--db');
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg === '--backups') {
      [backupDir, i] = takeValue(argv, i, '--backups');
    } else if (arg.startsWith('--backups=')) {
      backupDir = arg.slice('--backups='.length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  const result = await runBackup(dbPath, backupDir);
  console.log(`日备份: ${result.daily}`);
  console.log(`周备份: ${result.weekly ?? '本周已存在，跳过'}`);
  if (result.removed.length > 0) {
    console.log(`轮转删除: ${result.removed.join(', ')}`);
  } else {
    console.log('轮转删除: 无');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`备份失败: ${message}`);
    process.exitCode = 1;
  });
}
