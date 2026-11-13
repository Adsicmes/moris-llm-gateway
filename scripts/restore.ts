/**
 * 从一致性备份恢复 SQLite。
 *
 * 安全顺序：
 * 1. 必须显式 --confirm，且由操作者先停止服务；脚本无法可靠判断进程是否仍在写。
 * 2. 对备份执行 PRAGMA integrity_check。
 * 3. 先把当前目标库用 backup() 快照为 moris-pre-restore-*.sqlite，失败则中止。
 * 4. 通过同目录临时文件 + rename 替换目标库，不静默删除活库。
 * 5. 清理目标库旁的 -wal / -shm，避免旧 WAL 覆盖新数据。
 *
 * 脚本不读取业务表，也不打印任何密钥或凭据。
 *
 * 命令行：
 *   node dist/scripts/restore.js --backup <备份文件> [--db <目标库>] [--backups <快照目录>] --confirm
 */

import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, copyFile, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeBackupFile } from './backup.js';

export interface RestoreOptions {
  backupPath: string;
  dbPath: string;
  /** 恢复前快照的存放目录；默认与备份文件同目录。 */
  backupDir?: string;
  confirm: boolean;
  now?: Date;
}

export interface RestoreResult {
  restored: string;
  preRestore: string | null;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function fileSize(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined);
  return info?.size ?? 0;
}

async function cleanEmptySidecars(path: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    if ((await fileSize(sidecar)) === 0) {
      await rm(sidecar, { force: true }).catch(() => undefined);
    }
  }
}

async function verifyIntegrity(backupPath: string): Promise<void> {
  // 只恢复主文件；备份旁若有非空 WAL，说明快照不独立，必须拒绝。
  if ((await fileSize(`${backupPath}-wal`)) > 0) {
    throw new Error('备份旁存在非空 WAL，拒绝只恢复主文件；请重新生成备份');
  }

  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    const value = row?.['integrity_check'];
    if (value !== 'ok') {
      throw new Error(`备份完整性检查未通过: ${String(value ?? '无结果')}`);
    }
  } finally {
    db.close();
    // 只读打开 WAL 模式文件可能留下 0 字节旁文件，清掉以免误判。
    await cleanEmptySidecars(backupPath);
  }
}

async function snapshotCurrent(dbPath: string, directory: string, now: Date): Promise<string> {
  await ensureDirectory(directory);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let candidate = join(directory, `moris-pre-restore-${stamp}.sqlite`);
  let index = 1;
  while (await exists(candidate)) {
    candidate = join(directory, `moris-pre-restore-${stamp}-${index}.sqlite`);
    index += 1;
  }

  const temp = `${candidate}.tmp-${process.pid}`;
  const db = new DatabaseSync(dbPath);
  try {
    await backup(db, temp);
    finalizeBackupFile(temp);
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, candidate);
    return candidate;
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

async function removeSidecars(dbPath: string): Promise<void> {
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}

/**
 * 恢复备份。调用方必须保证服务已停止。
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  if (!options.confirm) {
    throw new Error('拒绝恢复：请先停止服务，并显式传入 --confirm');
  }

  const source = resolve(options.backupPath);
  const target = resolve(options.dbPath);
  if (source === target) {
    throw new Error('备份文件与目标数据库是同一路径');
  }

  const sourceInfo = await stat(source).catch(() => undefined);
  if (!sourceInfo?.isFile()) {
    throw new Error(`备份文件不存在或不是文件: ${source}`);
  }

  await verifyIntegrity(source);

  const now = options.now ?? new Date();
  const snapshotDir = resolve(options.backupDir ?? dirname(source));
  const targetInfo = await stat(target).catch(() => undefined);
  let preRestore: string | null = null;
  if (targetInfo?.isFile()) {
    preRestore = await snapshotCurrent(target, snapshotDir, now);
  }

  await ensureDirectory(dirname(target));

  const temp = `${target}.restore-${process.pid}-${Date.now()}.tmp`;
  try {
    await copyFile(source, temp);
    const handle = await open(temp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600).catch(() => undefined);

    // 新库已完整落盘后再清 WAL/SHM，避免中途失败连旧库的 WAL 也丢掉。
    await removeSidecars(target);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  await removeSidecars(target);
  await chmod(target, 0o600).catch(() => undefined);

  return { restored: target, preRestore };
}

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} 缺少参数值`);
  }
  return [value, index + 1];
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node dist/scripts/restore.js --backup <备份文件> [--db <目标库>] [--backups <快照目录>] --confirm');
    console.log('执行前必须先停止网关服务。');
    return;
  }

  const dataDir = process.env.MORIS_DATA_DIR ?? 'data';
  let backupPath: string | undefined;
  let dbPath = join(dataDir, 'moris.sqlite');
  let backupDir: string | undefined;
  let confirm = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) throw new Error('参数解析失败');
    if (arg === '--backup') {
      [backupPath, i] = takeValue(argv, i, '--backup');
    } else if (arg.startsWith('--backup=')) {
      backupPath = arg.slice('--backup='.length);
    } else if (arg === '--db') {
      [dbPath, i] = takeValue(argv, i, '--db');
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg === '--backups') {
      [backupDir, i] = takeValue(argv, i, '--backups');
    } else if (arg.startsWith('--backups=')) {
      backupDir = arg.slice('--backups='.length);
    } else if (arg === '--confirm') {
      confirm = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (backupPath === undefined) {
    throw new Error('缺少 --backup <备份文件>');
  }

  console.log('正在恢复。请确认网关服务已停止，且主密钥与备份时一致。');
  const result = await runRestore({ backupPath, dbPath, backupDir, confirm });
  if (result.preRestore) {
    console.log(`恢复前快照: ${result.preRestore}`);
  } else {
    console.log('恢复前快照: 目标库原先不存在，未生成');
  }
  console.log(`已恢复: ${result.restored}`);
  console.log('已清理目标库的 WAL/SHM。请重新启动服务并检查余额、目录与账目。');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`恢复失败: ${message}`);
    process.exitCode = 1;
  });
}
