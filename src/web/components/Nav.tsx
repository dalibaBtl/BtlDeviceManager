import {
  PANELS,
  checkForUpdate,
  restartApp,
  runInTerminal,
  selectedPanel,
  update,
  updateBuilt,
} from '../state.js';
import { describeUpdate } from '../../update/update.js';

/** Left pane: one entry per feature panel, and the app's own version at the bottom. */
export function Nav() {
  return (
    <nav class="pane nav">
      <header>
        <span class="title">BTL Device Manager</span>
      </header>
      <ul class="nav-list">
        {PANELS.map((p) => (
          <li
            key={p.id}
            class={selectedPanel.value === p.id ? 'selected' : ''}
            onClick={() => (selectedPanel.value = p.id)}
          >
            {p.label}
          </li>
        ))}
      </ul>
      <UpdateFooter />
    </nav>
  );
}

/**
 * Version line with the one action that fits the state: Update when the
 * repository is ahead, Restart once a newer build is on disk. The update
 * itself is typed into the terminal like every other change to the machine.
 */
export function UpdateFooter() {
  const u = update.value;
  if (updateBuilt.value) {
    return (
      <footer class="nav-foot warn">
        <span title="npm run build finished; the running server is still the old one">
          New build ready
        </span>
        <button class="primary" onClick={() => void restartApp()}>
          Restart
        </button>
      </footer>
    );
  }
  if (!u) return <footer class="nav-foot" />;
  const canUpdate = u.behind > 0 && u.blocked === null;
  return (
    <footer class={`nav-foot${canUpdate ? ' warn' : ''}`} title={describeUpdate(u)}>
      <span
        onClick={() => void checkForUpdate()}
        title={`${describeUpdate(u)}\nClick to check again`}
      >
        {canUpdate
          ? `Update available (${u.behind})`
          : `${u.version} · ${u.commit}${u.blocked === 'dirty' ? ' · local changes' : ''}`}
      </span>
      {canUpdate && (
        <button
          class="primary"
          title={u.subjects.join('\n')}
          onClick={() => runInTerminal({ action: 'app-update' })}
        >
          Update
        </button>
      )}
    </footer>
  );
}
