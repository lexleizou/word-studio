// workspace git 操作封装（阶段 5 会补 log/checkout API，这里先满足导入落地）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function git(dir, args) {
  return run('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

export async function initRepo(dir, message = 'import: 原始文档') {
  await git(dir, ['init']);
  await commitAll(dir, message);
}

// 全部变更入库；无变更时返回 { changed: false }
export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  const { stdout } = await git(dir, ['status', '--porcelain']);
  if (!stdout.trim()) return { changed: false };
  await git(dir, ['-c', 'user.name=word-studio', '-c', 'user.email=studio@local', 'commit', '-m', message]);
  return { changed: true };
}

export async function log(dir, limit = 50) {
  try {
    const { stdout } = await git(dir, ['log', `-${limit}`, '--pretty=format:%H%x09%ad%x09%s', '--date=iso']);
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, date, ...msg] = line.split('\t');
      return { hash, date, message: msg.join('\t') };
    });
  } catch {
    return [];
  }
}

// 回退到指定 commit：检出其内容后立即产生一个新 commit（不改写历史）
export async function checkout(dir, hash, message) {
  await git(dir, ['checkout', hash, '--', '.']);
  return commitAll(dir, message || `revert: 回退到 ${hash.slice(0, 7)}`);
}
