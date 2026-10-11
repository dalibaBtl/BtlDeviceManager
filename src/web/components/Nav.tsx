import { PANELS, selectedPanel } from '../state.js';

/** Left pane: one entry per feature panel. */
export function Nav() {
  return (
    <nav class="pane nav">
      <header>
        <span class="title">BTL Manager</span>
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
    </nav>
  );
}
