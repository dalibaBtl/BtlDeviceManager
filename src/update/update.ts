/**
 * The pure part of self-update: turning git's answers into an {@link UpdateState}.
 * Nothing here runs a process, so it is unit-tested with captured output.
 */
import { UPDATE_SUBJECTS_SHOWN, type UpdateBlocker, type UpdateState } from '../shared/types.js';

/** What the CLI asked git for; every field is raw stdout, or `null` when the command failed. */
export interface GitAnswers {
  /** `git rev-parse --short HEAD` */
  head: string | null;
  /** `git rev-parse --abbrev-ref HEAD`; `HEAD` when detached. */
  branch: string | null;
  /** `git rev-parse --abbrev-ref @{upstream}`; `null` when the branch tracks nothing. */
  upstream: string | null;
  /** `git status --porcelain --untracked-files=no` */
  status: string | null;
  /** `git rev-list --count HEAD..origin/main` */
  behind: string | null;
  /** `git log --format=%s HEAD..origin/main` */
  log: string | null;
  /** Whether `git fetch` succeeded this time. */
  fetched: boolean;
}

/**
 * Builds the state. Untracked files do not count as dirty: a station may
 * carry a stray file in the clone and `git pull --ff-only` copes with that;
 * modified tracked files are what makes a pull fail or, worse, a developer's
 * work disappear.
 */
export function updateState(version: string, g: GitAnswers, now = Date.now()): UpdateState {
  const name = (g.branch ?? '').trim();
  const branch = name === '' || name === 'HEAD' ? null : name;
  return {
    version,
    commit: (g.head ?? '').trim() || 'unknown',
    branch,
    behind: parseCount(g.behind),
    subjects: parseSubjects(g.log),
    blocked: blocker(branch, g),
    checkedAt: now,
  };
}

function blocker(branch: string | null, g: GitAnswers): UpdateBlocker | null {
  if ((g.status ?? '').trim() !== '') return 'dirty';
  if (branch === null || (g.upstream ?? '').trim() === '') return 'detached';
  if (!g.fetched) return 'offline';
  return null;
}

/** `rev-list --count` prints one integer; anything else counts as nothing to update. */
export function parseCount(text: string | null): number {
  const n = Number((text ?? '').trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function parseSubjects(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, UPDATE_SUBJECTS_SHOWN);
}

/** One line for the CLI and the Status summary: `0.1.0 (abc1234), 3 commits behind`. */
export function describeUpdate(u: UpdateState): string {
  const base = `${u.version} (${u.commit}${u.branch ? `, ${u.branch}` : ''})`;
  if (u.blocked === 'dirty') return `${base}, local changes, not updated automatically`;
  if (u.blocked === 'detached') return `${base}, not tracking origin, not updated automatically`;
  const behind =
    u.behind === 0 ? 'up to date' : `${u.behind} commit${u.behind === 1 ? '' : 's'} behind`;
  return `${base}, ${behind}${u.blocked === 'offline' ? ' (could not reach the repository)' : ''}`;
}
