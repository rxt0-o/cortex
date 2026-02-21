import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  author: string;
}

export interface GitDiffStat {
  file: string;
  additions: number;
  deletions: number;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: cwd ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function getStatus(cwd?: string): Promise<string> {
  return git(['status', '--porcelain'], cwd);
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export async function getLog(limit = 10, cwd?: string): Promise<GitLogEntry[]> {
  const raw = await git(
    ['log', `--max-count=${limit}`, '--format=%H|%aI|%s|%an'],
    cwd
  );
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [hash, date, message, author] = line.split('|');
    return { hash, date, message, author };
  });
}

export async function getDiff(ref?: string, cwd?: string): Promise<string> {
  const args = ['diff'];
  if (ref) args.push(ref);
  return git(args, cwd);
}

export async function getDiffStat(ref?: string, cwd?: string): Promise<GitDiffStat[]> {
  const args = ['diff', '--numstat'];
  if (ref) args.push(ref);
  const raw = await git(args, cwd);
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [add, del, file] = line.split('\t');
    return {
      file,
      additions: parseInt(add, 10) || 0,
      deletions: parseInt(del, 10) || 0,
    };
  });
}

export async function getChangedFiles(sinceCommit?: string, cwd?: string): Promise<string[]> {
  if (sinceCommit) {
    const raw = await git(['diff', '--name-only', sinceCommit], cwd);
    return raw ? raw.split('\n') : [];
  }
  // Uncommitted changes
  const raw = await git(['diff', '--name-only', 'HEAD'], cwd);
  const staged = await git(['diff', '--name-only', '--cached'], cwd);
  const files = new Set<string>();
  if (raw) raw.split('\n').forEach((f) => files.add(f));
  if (staged) staged.split('\n').forEach((f) => files.add(f));
  return [...files];
}

export async function getFileBlame(filePath: string, cwd?: string): Promise<string> {
  return git(['blame', '--line-porcelain', filePath], cwd);
}

export async function getLastCommitForFile(filePath: string, cwd?: string): Promise<GitLogEntry | null> {
  const entries = await getLog(1, cwd);
  const raw = await git(['log', '-1', '--format=%H|%aI|%s|%an', '--', filePath], cwd);
  if (!raw) return entries[0] ?? null;
  const [hash, date, message, author] = raw.split('|');
  return { hash, date, message, author };
}

export async function getSessionDiff(startCommit: string, endCommit?: string, cwd?: string): Promise<string> {
  const args = ['diff', startCommit];
  if (endCommit) args.push(endCommit);
  return git(args, cwd);
}
