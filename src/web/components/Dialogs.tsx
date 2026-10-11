import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

/**
 * Promise-based confirmation dialog, so call sites read linearly:
 * `if (await askConfirm(...)) …`. Escape and the backdrop both mean "no".
 */
interface ConfirmSpec {
  title: string;
  text: string;
  okLabel: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

const current = signal<ConfirmSpec | null>(null);

export function askConfirm(
  title: string,
  text: string,
  opts: { okLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    current.value = {
      title,
      text,
      okLabel: opts.okLabel ?? 'OK',
      danger: opts.danger ?? false,
      resolve,
    };
  });
}

function answer(spec: ConfirmSpec, v: boolean): void {
  spec.resolve(v);
  current.value = null;
}

/** Hosts the dialog when one is open. */
export function Dialogs() {
  const spec = current.value;
  useEffect(() => {
    if (!spec) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && answer(spec, false);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [spec]);
  if (!spec) return null;
  return (
    <div class="backdrop" onClick={() => answer(spec, false)}>
      <div class="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{spec.title}</h2>
        <p>{spec.text}</p>
        <div class="dialog-actions">
          <button onClick={() => answer(spec, false)}>Cancel</button>
          <button class={spec.danger ? 'danger' : 'primary'} onClick={() => answer(spec, true)}>
            {spec.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
