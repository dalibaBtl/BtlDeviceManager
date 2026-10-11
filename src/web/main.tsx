import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { socket } from './api.js';
import { Dialogs } from './components/Dialogs.jsx';
import { Nav } from './components/Nav.jsx';
import { DisplaysPanel } from './components/DisplaysPanel.jsx';
import { PrintersPanel } from './components/PrintersPanel.jsx';
import { TerminalPane } from './components/TerminalPane.jsx';
import { applyServerMessage, notices, selectedPanel } from './state.js';
import './styles.css';

socket.onMessage(applyServerMessage);
socket.connect();

/** Pane sizes persisted per browser profile; purely cosmetic so localStorage is fine. */
function usePersistedSize(key: string, initial: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    try {
      return Number(localStorage.getItem(key)) || initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (n: number) => {
      setV(n);
      try {
        localStorage.setItem(key, String(n));
      } catch {
        // storage unavailable: keep the in-memory value
      }
    },
  ];
}

/** Drag handle that reports pointer movement along one axis. */
function Splitter({ axis, onMove }: { axis: 'x' | 'y'; onMove: (delta: number) => void }) {
  const last = useRef(0);
  return (
    <div
      class={`splitter ${axis}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        last.current = axis === 'x' ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const cur = axis === 'x' ? e.clientX : e.clientY;
        onMove(cur - last.current);
        last.current = cur;
      }}
    />
  );
}

const MIN_NAV = 140;
const MAX_NAV = 400;
const MIN_PANEL = 120;
const MIN_TERM = 60;

/** Current viewport size, re-rendered on resize so pane sizes can be clamped to it. */
function useViewport(): { height: number } {
  const [size, setSize] = useState({ height: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ height: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

function App() {
  const [nav, setNav] = usePersistedSize('btlm.nav', 200);
  const [termPref, setTerm] = usePersistedSize('btlm.term', 260);
  const { height } = useViewport();
  // The terminal gives way to the panel rather than the other way round.
  const term = Math.max(MIN_TERM, Math.min(termPref, height - MIN_PANEL - 6));

  return (
    <div class="app" style={{ gridTemplateColumns: `${nav}px 6px 1fr` }}>
      <Nav />
      <Splitter axis="x" onMove={(d) => setNav(Math.min(MAX_NAV, Math.max(MIN_NAV, nav + d)))} />
      <div class="middle" style={{ gridTemplateRows: `minmax(${MIN_PANEL}px, 1fr) 6px ${term}px` }}>
        {selectedPanel.value === 'printers' && <PrintersPanel />}
        {selectedPanel.value === 'displays' && <DisplaysPanel />}
        <Splitter axis="y" onMove={(d) => setTerm(Math.max(MIN_TERM, term - d))} />
        <TerminalPane />
      </div>
      <Dialogs />
      <div class="notices">
        {notices.value.map((n) => (
          <div key={n.id} class={`notice ${n.level}`}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
