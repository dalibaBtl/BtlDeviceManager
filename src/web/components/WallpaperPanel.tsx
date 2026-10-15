import type { WallpaperFit, WallpaperSetting, WallpaperState } from '../../shared/types.js';
import { api } from '../api.js';
import {
  refreshWallpaper,
  resetWallpaper,
  setWallpaperColor,
  setWallpaperFit,
  uploadWallpaper,
  wallpaper,
  wallpaperBusy,
  wallpaperError,
} from '../state.js';
import { scannedLabel } from './PrintersPanel.jsx';
import { Card, Row } from './StatusPanel.jsx';

/**
 * Background of every output: a picture or one colour. Each change is
 * direct, like the keyboard layout: `btl-wallpaper` rewrites a file in the
 * user's own sway config and applies it with `swaymsg`, no root and at most a
 * one-line failure shown as a notice.
 */
export function WallpaperPanel() {
  const w = wallpaper.value;
  const error = wallpaperError.value;
  return (
    <section class="pane panel">
      <header>
        <span class="title">Wallpaper</span>
        <span class="meta">{scannedLabel(w?.scannedAt ?? null)}</span>
        <button title="Read the setting again" onClick={() => void refreshWallpaper()}>
          Refresh
        </button>
      </header>
      <div class="content">
        {error && (
          <p class="problem">
            Could not read the wallpaper: <code>{error}</code>
          </p>
        )}
        {!error && !w && <p class="empty">Reading…</p>}
        {w && <WallpaperBody w={w} />}
      </div>
    </section>
  );
}

function WallpaperBody({ w }: { w: WallpaperState }) {
  const shown = w.current ?? w.fallback;
  const busy = wallpaperBusy.value;
  const image = shown?.kind === 'image' ? shown : null;
  const color = shown?.color ?? '#000000';
  return (
    <div class="status">
      <Card title="Background">
        <Preview w={w} shown={shown} />
        <Row k="In use" v={describeWallpaper(w)} warn={w.imageMissing} />
        <div class="choices">
          <label class={`button primary${busy ? ' disabled' : ''}`}>
            Choose picture…
            <input
              type="file"
              accept="image/png,image/jpeg"
              hidden
              disabled={busy}
              onChange={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                const file = input.files?.[0];
                input.value = '';
                if (file) void uploadWallpaper(file, image?.fit ?? 'fill', image?.color ?? null);
              }}
            />
          </label>
          <label class="button" title="One colour on every display, no picture">
            Plain colour
            <input
              type="color"
              class="swatch"
              value={color}
              disabled={busy}
              onChange={(e) => void setWallpaperColor((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          {w.current && (
            <button
              class="quiet"
              disabled={busy}
              title="Back to what this station's sway config sets"
              onClick={() => void resetWallpaper()}
            >
              Reset to default
            </button>
          )}
        </div>
        {image && (
          <div class="kv">
            <span class="k">Fit</span>
            <span class="v">
              <select
                class="mode"
                disabled={busy}
                value={image.fit}
                onChange={(e) =>
                  void setWallpaperFit(
                    (e.currentTarget as HTMLSelectElement).value as WallpaperFit,
                    image.color,
                  )
                }
              >
                {w.fits.map((f) => (
                  <option key={f} value={f}>
                    {FIT_LABELS[f]}
                  </option>
                ))}
              </select>{' '}
              <label
                class="meta"
                title="Colour of the bars a picture leaves when it does not cover the display"
              >
                bars{' '}
                <input
                  type="color"
                  class="swatch"
                  value={image.color ?? '#000000'}
                  disabled={busy}
                  onChange={(e) =>
                    void setWallpaperFit(image.fit, (e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
            </span>
          </div>
        )}
        <p class="meta">
          Applies to every display at once and is kept across restarts. The picture is copied, so
          the original can be moved or deleted.
        </p>
      </Card>
    </div>
  );
}

const FIT_LABELS: Record<WallpaperFit, string> = {
  fill: 'Fill (crop to cover)',
  fit: 'Fit (whole picture, bars)',
  center: 'Center (original size)',
  tile: 'Tile',
  stretch: 'Stretch (distort)',
};

/** CSS that approximates each sway mode in the preview box. */
const FIT_CSS: Record<WallpaperFit, string> = {
  fill: 'cover',
  fit: 'contain',
  center: 'none',
  tile: 'none',
  stretch: 'fill',
};

function Preview({ w, shown }: { w: WallpaperState; shown: WallpaperSetting | null }) {
  const bg = shown?.color ?? '#000000';
  if (shown?.kind !== 'image' || w.imageMissing) {
    return <div class="wallpaper-preview" style={{ background: bg }} />;
  }
  const src = api.src('/api/wallpaper/image', { v: String(w.scannedAt) });
  if (shown.fit === 'tile') {
    return (
      <div
        class="wallpaper-preview"
        style={{ background: `${bg} url("${src}") repeat top left / 25%` }}
      />
    );
  }
  return (
    <div class="wallpaper-preview" style={{ background: bg }}>
      <img src={src} alt="" style={{ objectFit: FIT_CSS[shown.fit] }} />
    </div>
  );
}

/** The background in words, saying where it comes from. */
export function describeWallpaper(w: WallpaperState): string {
  const s = w.current ?? w.fallback;
  if (!s) return 'sway default';
  const what =
    s.kind === 'color'
      ? `colour ${s.color}`
      : `picture, ${FIT_LABELS[s.fit].split(' ')[0]?.toLowerCase()}`;
  if (w.imageMissing) return `${what}, but the picture is missing; choose it again`;
  return w.current ? what : `${what} (this station's default)`;
}
