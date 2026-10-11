import { computed, signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { layoutFromOutputs } from '../../displays/config.js';
import {
  entryRect,
  normalize,
  overlappingPairs,
  snap,
  type Rect,
} from '../../displays/geometry.js';
import { describeMode, modeKey } from '../../displays/sway.js';
import type { DisplayLayout, DisplayOutput, LayoutEntry, Transform } from '../../shared/types.js';
import { SCALES, TRANSFORMS } from '../../shared/types.js';
import { api } from '../api.js';
import { displays, displaysError, guard, notify, runInTerminal } from '../state.js';
import { askConfirm } from './Dialogs.jsx';

/**
 * The arrangement being edited. It starts as what sway reports and is reset to
 * that whenever sway's list changes (hotplug, reload) unless the user has
 * unsaved edits, which are kept so a monitor waking up does not throw them away.
 */
const draft = signal<LayoutEntry[]>([]);
const dirty = signal(false);

/** Canvas width in CSS pixels; the arrangement is scaled to fit it. */
const CANVAS_WIDTH = 720;
const CANVAS_PADDING = 24;
/** Snap distance in canvas pixels. */
const SNAP_PX = 12;

function resetDraft(outputs: DisplayOutput[]): void {
  draft.value = layoutFromOutputs(outputs).outputs;
  dirty.value = false;
}

/** Keeps the draft in step with sway while there are no local edits. */
displays.subscribe((outputs) => {
  if (!dirty.value) resetDraft(outputs);
  else {
    // Keep edits, but drop outputs that vanished and add ones that appeared.
    const current = layoutFromOutputs(outputs).outputs;
    draft.value = [
      ...draft.value.filter((d) => current.some((c) => c.identifier === d.identifier)),
      ...current.filter((c) => !draft.value.some((d) => d.identifier === c.identifier)),
    ];
  }
});

const problems = computed(() => {
  const list: string[] = [];
  if (!draft.value.some((e) => e.enabled)) list.push('At least one display must stay enabled.');
  for (const [a, b] of overlappingPairs(draft.value)) list.push(`${a} and ${b} overlap.`);
  return list;
});

function update(identifier: string, patch: Partial<LayoutEntry>): void {
  draft.value = draft.value.map((e) => (e.identifier === identifier ? { ...e, ...patch } : e));
  dirty.value = true;
}

/** Right-click-free canvas: drag a rectangle to move a display, with edge snapping. */
export function DisplaysPanel() {
  const error = displaysError.value;
  const entries = draft.value;
  const outputs = displays.value;
  const apply = () =>
    guard(async () => {
      const layout: DisplayLayout = { version: 1, outputs: normalizeEnabled(entries) };
      const res = await api.post<{ file: string; preview: string; current: string }>(
        '/api/displays/prepare',
        { layout },
      );
      const ok = await askConfirm(
        'Write outputs.conf and reload sway?',
        res.current.trim() === ''
          ? `The file does not exist yet. It will contain:\n\n${res.preview}`
          : `Current file:\n\n${res.current}\n\nWill be replaced by:\n\n${res.preview}`,
        { okLabel: 'Apply' },
      );
      if (!ok) return;
      runInTerminal({ action: 'display-apply', file: res.file });
      dirty.value = false;
      notify('info', 'Applying in the terminal; the arrangement updates when sway reloads.');
    });

  return (
    <section class="pane panel">
      <header>
        <span class="title">Displays</span>
        {dirty.value && <span class="meta">unsaved changes</span>}
        <button disabled={!dirty.value} onClick={() => resetDraft(outputs)}>
          Reset
        </button>
        <button
          class="primary"
          disabled={entries.length === 0 || problems.value.length > 0}
          onClick={() => void apply()}
          title="Write the arrangement to outputs.conf, also when unchanged, so it survives replugging"
        >
          Apply…
        </button>
      </header>
      <div class="content">
        {error && (
          <p class="problem">
            Could not read displays: <code>{error}</code>
          </p>
        )}
        {!error && entries.length === 0 && <p class="empty">No displays reported by sway.</p>}
        {entries.length > 0 && <Canvas entries={entries} />}
        {problems.value.map((p) => (
          <p key={p} class="problem">
            {p}
          </p>
        ))}
        {entries.length > 0 && (
          <table class="displays">
            <thead>
              <tr>
                <th>Display</th>
                <th>Mode</th>
                <th>Scale</th>
                <th>Rotation</th>
                <th>Position</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <DisplayRow
                  key={e.identifier}
                  entry={e}
                  output={outputs.find((o) => o.identifier === e.identifier)}
                />
              ))}
            </tbody>
          </table>
        )}
        <p class="meta hint">
          Drag displays to arrange them; edges snap together. Displays are matched by make, model
          and serial, not by the port they are plugged into.
        </p>
      </div>
    </section>
  );
}

/** Enabled outputs shifted to the origin, as the config writer does, so the dialog shows final numbers. */
function normalizeEnabled(entries: LayoutEntry[]): LayoutEntry[] {
  const on = normalize(entries.filter((e) => e.enabled));
  return entries.map((e) => on.find((n) => n.identifier === e.identifier) ?? e);
}

function DisplayRow({
  entry: e,
  output,
}: {
  entry: LayoutEntry;
  output: DisplayOutput | undefined;
}) {
  const modes = output?.modes ?? [e.mode];
  return (
    <tr class={e.enabled ? '' : 'away'}>
      <td class="name">
        {e.name}
        <span class="meta"> {e.identifier.trim()}</span>
      </td>
      <td>
        <select
          class="mode"
          value={modeKey(e.mode)}
          onChange={(ev) => {
            const m = modes.find((x) => modeKey(x) === (ev.target as HTMLSelectElement).value);
            if (m) update(e.identifier, { mode: m });
          }}
        >
          {modes.map((m) => (
            <option key={modeKey(m)} value={modeKey(m)}>
              {describeMode(m)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          class="mode"
          value={String(e.scale)}
          onChange={(ev) =>
            update(e.identifier, { scale: Number((ev.target as HTMLSelectElement).value) })
          }
        >
          {SCALES.map((s) => (
            <option key={s} value={String(s)}>
              {s}×
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          class="mode"
          value={e.transform}
          onChange={(ev) =>
            update(e.identifier, { transform: (ev.target as HTMLSelectElement).value as Transform })
          }
        >
          {TRANSFORMS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td class="mono">{e.enabled ? `${e.x}, ${e.y}` : '–'}</td>
      <td>
        <input
          type="checkbox"
          checked={e.enabled}
          onChange={(ev) =>
            update(e.identifier, { enabled: (ev.target as HTMLInputElement).checked })
          }
        />
      </td>
    </tr>
  );
}

/** Scale factor and offset that fit all enabled rectangles into the canvas. */
export function fitToCanvas(
  rects: Rect[],
  width: number,
  padding: number,
): { k: number; height: number } {
  if (rects.length === 0) return { k: 1, height: 120 };
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const k = Math.min((width - 2 * padding) / Math.max(1, maxX), 0.25);
  return { k, height: Math.ceil(maxY * k) + 2 * padding };
}

function Canvas({ entries }: { entries: LayoutEntry[] }) {
  const on = entries.filter((e) => e.enabled);
  const rects = on.map(entryRect);
  const { k, height } = fitToCanvas(rects, CANVAS_WIDTH, CANVAS_PADDING);
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    origin: Rect;
  } | null>(null);

  // Pointer moves are tracked on the window so a fast drag outside the rectangle still follows.
  useEffect(() => {
    if (!drag) return;
    const entry = entries.find((e) => e.identifier === drag.id);
    if (!entry) return;
    const others = on.filter((e) => e.identifier !== drag.id).map(entryRect);
    const move = (ev: PointerEvent) => {
      const moving = {
        ...drag.origin,
        x: drag.origin.x + (ev.clientX - drag.startX) / k,
        y: drag.origin.y + (ev.clientY - drag.startY) / k,
      };
      const pos = snap(moving, others, SNAP_PX / k);
      update(drag.id, pos);
    };
    const up = () => {
      // Dropping may leave the arrangement off the origin; sway wants it anchored there.
      draft.value = normalizeEnabled(draft.value);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, k]);

  return (
    <svg
      ref={svg}
      class="canvas"
      width={CANVAS_WIDTH}
      height={height}
      viewBox={`0 0 ${CANVAS_WIDTH} ${height}`}
    >
      {on.map((e, i) => {
        const r = rects[i]!;
        const x = CANVAS_PADDING + r.x * k;
        const y = CANVAS_PADDING + r.y * k;
        const overlapping = problems.value.some((p) => p.includes(e.name) && p.includes('overlap'));
        return (
          <g
            key={e.identifier}
            class={`display ${overlapping ? 'bad' : ''} ${drag?.id === e.identifier ? 'dragging' : ''}`}
            onPointerDown={(ev) => {
              ev.preventDefault();
              setDrag({ id: e.identifier, startX: ev.clientX, startY: ev.clientY, origin: r });
            }}
          >
            <rect x={x} y={y} width={r.width * k} height={r.height * k} rx={3} />
            <text x={x + 8} y={y + 18}>
              {e.name}
            </text>
            <text x={x + 8} y={y + 34} class="small">
              {r.width}×{r.height} at {e.x}, {e.y}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
