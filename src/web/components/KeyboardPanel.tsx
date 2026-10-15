import type { KeyboardState } from '../../shared/types.js';
import { keyboard, keyboardError, refreshKeyboard, setKeyboardLayout } from '../state.js';
import { scannedLabel } from './PrintersPanel.jsx';
import { Card, Row } from './StatusPanel.jsx';

/**
 * Keyboard layout of this station: Czech QWERTY or QWERTZ. The switch is
 * direct, not typed into the terminal: it writes two lines into the user's own
 * sway config and applies them with `swaymsg`, which cannot need root and
 * fails, if at all, with one line shown as a notice.
 */
export function KeyboardPanel() {
  const k = keyboard.value;
  const error = keyboardError.value;
  return (
    <section class="pane panel">
      <header>
        <span class="title">Keyboard</span>
        <span class="meta">{scannedLabel(k?.scannedAt ?? null)}</span>
        <button title="Read the layout again" onClick={() => void refreshKeyboard()}>
          Refresh
        </button>
      </header>
      <div class="content">
        {error && (
          <p class="problem">
            Could not read the keyboard: <code>{error}</code>
          </p>
        )}
        {!error && !k && <p class="empty">Reading…</p>}
        {k && <KeyboardBody k={k} />}
      </div>
    </section>
  );
}

function KeyboardBody({ k }: { k: KeyboardState }) {
  return (
    <div class="status">
      <Card title="Layout">
        <div class="choices">
          {k.offered.map((l) => (
            <button
              key={l.variant}
              class={k.current === l.variant ? 'primary' : ''}
              aria-pressed={k.current === l.variant}
              onClick={() => {
                if (k.current !== l.variant) void setKeyboardLayout(l.variant);
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
        <Row k="In use now" v={describeActive(k)} warn={k.active.length > 0 && !k.current} />
        <input
          class="try"
          type="text"
          placeholder="Type here to try it: Y and Z swap places"
          spellcheck={false}
          autocomplete="off"
        />
        <p class="meta">
          Applies at once and is kept across restarts. Windows in the virtual machine keeps its own
          layout; change it there.
        </p>
      </Card>
    </div>
  );
}

/**
 * The layout in words. Keyboards that disagree, or a layout the panel does not
 * offer, mean a line elsewhere in the sway config wins; the panel says what it
 * sees rather than pretending one of its options is active.
 */
export function describeActive(k: KeyboardState): string {
  if (k.active.length === 0) return 'no keyboard connected';
  const current = k.offered.find((l) => l.variant === k.current);
  if (current) return current.label;
  if (k.active.length > 1) return `keyboards differ: ${k.active.join(', ')}`;
  return `${k.active.join(', ')} (set elsewhere in the sway config)`;
}
