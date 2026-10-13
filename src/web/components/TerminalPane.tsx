import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { socket } from '../api.js';
import { terminalFocus } from '../state.js';

/**
 * Embedded terminal under the panel. One shell per browser window, started in
 * the home directory; panel actions type their commands into it so `sudo`
 * prompts and errors are seen and can be copied.
 */
export function TerminalPane() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#141618',
        foreground: '#d6d8dc',
        cursor: '#d6d8dc',
        selectionBackground: '#3a4a60',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const open = () => {
      fit.fit();
      socket.send({ type: 'term-open', cols: term.cols, rows: term.rows });
    };
    open();
    const offOpen = socket.onOpen(() => {
      term.reset();
      open();
    });
    // After the shell exits, Enter starts a new one.
    const exited = { current: false };
    const offMsg = socket.onMessage((m) => {
      if (m.type === 'term-data') term.write(m.data);
      else if (m.type === 'term-exit') {
        exited.current = true;
        term.writeln(`\r\n[shell exited with code ${m.code}; press Enter to start a new one]`);
      }
    });
    let focusSeen = terminalFocus.peek();
    const offFocus = effect(() => {
      if (terminalFocus.value === focusSeen) return;
      focusSeen = terminalFocus.value;
      term.focus();
    });
    const onData = term.onData((data) => socket.send({ type: 'term-input', data }));
    const onKey = term.onKey(({ domEvent }) => {
      if (domEvent.key === 'Enter' && exited.current) {
        exited.current = false;
        term.reset();
        open();
      }
    });
    const ro = new ResizeObserver(() => {
      fit.fit();
      socket.send({ type: 'term-resize', cols: term.cols, rows: term.rows });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      offFocus();
      onData.dispose();
      onKey.dispose();
      offMsg();
      offOpen();
      term.dispose();
    };
  }, []);

  return <div class="terminal" ref={host} />;
}
