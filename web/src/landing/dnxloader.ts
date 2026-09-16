/**
 * DNX / PHOSPHOR
 * Live ASCII boot animation. No images, external fonts or runtime dependencies.
 * Importing this module is SSR-safe; instantiate it after a canvas is mounted.
 *
 * ## Where this came from
 *
 * **Brought in unmodified on 2026-09-16**, from the bundle the owner commissioned. The bundle is
 * kept whole outside this repository, with its provenance and its checksums, at
 * `dn_sysex/00_References/dnx-startup-screen/` — 53 MB of concept art, earlier renderer outputs
 * and a colour reference, of which **this one file is the entire runtime**. It draws the ASCII
 * itself: no images, no fonts, no network.
 *
 * It typechecks under this repository's own strict configuration as it arrived, so it is here as
 * delivered rather than adapted. The numbers it is driven with are not here either — see
 * `main.ts`, where they are the owner's own, chosen against this renderer on a tuning bench.
 */

export interface DNXPalette {
  background: string;
  dim: string;
  muted: string;
  foreground: string;
  highlight: string;
  glow: string;
}

export interface DNXLoaderOptions {
  /** Time from signal corruption to readable logo, in milliseconds. Default: 5600. */
  durationMs?: number;
  /** Residual character/row glitches, 0..1. Default: 0.12. Zero disables them. */
  idleGlitch?: number;
  /** Phosphor bloom strength, 0..1. Default: 0.65. */
  glow?: number;
  scanlines?: boolean;
  /** Render-rate cap. Animation speed is time-based, not frame-based. */
  fps?: number;
  /** Limit the backing resolution on high-density screens. Default: 2. */
  maxDpr?: number;
  seed?: number;
  autoplay?: boolean;
  /** Default true. Reduced motion shows the resolved logo, without animation. */
  respectReducedMotion?: boolean;
  palette?: Partial<DNXPalette>;
}

export const DNX_PALETTE: Readonly<DNXPalette> = Object.freeze({
  background: '#0b1314',
  dim: '#2f4a47',
  muted: '#5b8a82',
  foreground: '#9bd3c7',
  highlight: '#d0eee6',
  glow: '#65c5be',
});

// Genuine, editable ASCII, not a bitmap-to-text approximation.
// Every row is the same width. Backslashes are escaped only for TypeScript.
const LOGO_ROWS: readonly string[] = [
  ".-+####################+-.          ++######               ######++     .+#####+                 +#####+.",
  ".#########################+.        :#######\\              #######:       \\#####\\               /#####/  ",
  ":############################:      :########\\             #######:        \\######\\            /#####/   ",
  ":#############################:     :##########\\           #######:         \\######\\         /#####/     ",
  ":#######:             :#######:     :###########\\          #######:           \\#####\\       /#####/      ",
  ":#######:             :#######:     :############\\         #######:            \\#####\\     /#####/       ",
  ":#######:             :#######:     :#############\\        #######:             \\#####\\   /#####/        ",
  ":#######:             :#######:     :##############\\       #######:              \\#############/         ",
  ":#######:             :#######:     :#######  ######\\      #######:               \\##########/           ",
  ":#######:             :#######:     :#######   ######\\     #######:                 \\#######/            ",
  ":#######:             :#######:     :#######    ######\\    #######:                  /#####/             ",
  ":#######:             :#######:     :#######     ######\\   #######:                 /#######\\            ",
  ":#######:             :#######:     :#######      ######\\  #######:               /##########\\           ",
  ":#######:             :#######:     :#######       ###############:              /#############\\         ",
  ":#######:             :#######:     :#######        ##############:             /#####/   \\#####\\        ",
  ":#######:             :#######:     :#######         #############:            /#####/     \\#####\\       ",
  ":#######:             :#######:     :#######          ############:           /#####/       \\#####\\      ",
  ":#############################:     :#######           ###########:          /#####/         \\#####\\     ",
  ":############################:      :#######             #########:        /#####/             \\#####\\   ",
  ".#########################+.        :#######              ########:       /#####/               \\#####\\  ",
  "'-+####################+-.          ++######               ######++     .+#####+                 +#####+."
];

export const DNX_ASCII = LOGO_ROWS.join('\n');

const COLS = LOGO_ROWS[0]!.length;
const ROWS = LOGO_ROWS.length;
const PAD_X = 7;
const PAD_Y = 4;
const GLYPHS = Array.from(new Set((DNX_ASCII + '#+.-:=/\\|_[]<>01*%?!{}').replace(/\s/g, '')));
const SCRAMBLE = '01/:=+<>[]{}#%*?_|-\\';
const FONT = '"Courier New", Courier, monospace';

const clamp = (n: number, min = 0, max = 1): number => Math.min(max, Math.max(min, n));
const smooth = (n: number): number => { const t = clamp(n); return t * t * (3 - 2 * t); };
const finite = (n: number | undefined, fallback: number, min: number, max: number): number =>
  n === undefined || !Number.isFinite(n) ? fallback : clamp(n, min, max);

/** Stable integer noise: seek(t) produces the same frame every time. */
function random(key: number): number {
  let n = key | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('DNXLoader requires a Canvas 2D context.');
  return ctx;
}

type Cell = { x: number; y: number; char: string; key: number; lockAt: number; shade: number };
type ResolveTween = { at: number; from: number; duration: number };

export class DNXLoader {
  readonly durationMs: number;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ink: HTMLCanvasElement;
  private readonly inkCtx: CanvasRenderingContext2D;
  private readonly bloom: HTMLCanvasElement;
  private readonly bloomCtx: CanvasRenderingContext2D;
  private readonly atlas: HTMLCanvasElement;
  private readonly glyphIndex = new Map(GLYPHS.map((char, i) => [char, i]));
  private readonly media: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver | undefined;
  private readonly cells: Cell[] = [];
  private readonly palette: DNXPalette;
  private readonly seed: number;
  private readonly fps: number;
  private readonly maxDpr: number;
  private readonly hasScanlines: boolean;
  private readonly respectReducedMotion: boolean;
  private readonly oldRole: string | null;
  private readonly oldLabel: string | null;
  private noisePattern: CanvasPattern | null = null;
  private scanPattern: CanvasPattern | null = null;
  private vignette: CanvasGradient | null = null;
  private idleGlitch: number;
  private glow: number;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private fontSize = 16;
  private cellWidth = 10;
  private lineHeight = 21;
  private originX = 0;
  private originY = 0;
  private spriteWidth = 0;
  private spriteHeight = 0;
  private spritePad = 0;
  private elapsed = 0;
  private lastTime: number | null = null;
  private lastPaint = -Infinity;
  private raf: number | null = null;
  private playing = false;
  private inView = true;
  private disposed = false;
  private motionReduced = false;
  private resolveTween: ResolveTween | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, options: DNXLoaderOptions = {}) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Create DNXLoader in the browser after your canvas is mounted.');
    }
    this.ctx = context(canvas);
    this.ink = document.createElement('canvas');
    this.inkCtx = context(this.ink);
    this.bloom = document.createElement('canvas');
    this.bloomCtx = context(this.bloom);
    this.atlas = document.createElement('canvas');
    this.durationMs = finite(options.durationMs, 5600, 0, 120000);
    this.idleGlitch = finite(options.idleGlitch, 0.12, 0, 1);
    this.glow = finite(options.glow, 0.65, 0, 1);
    this.fps = finite(options.fps, 30, 1, 60);
    this.maxDpr = finite(options.maxDpr, 2, 0.5, 3);
    this.seed = finite(options.seed, 1986, -2147483648, 2147483647) | 0;
    this.hasScanlines = options.scanlines ?? true;
    this.respectReducedMotion = options.respectReducedMotion ?? true;
    this.palette = { ...DNX_PALETTE, ...options.palette };
    this.oldRole = canvas.getAttribute('role');
    this.oldLabel = canvas.getAttribute('aria-label');
    if (!this.oldRole) canvas.setAttribute('role', 'img');
    if (!this.oldLabel) canvas.setAttribute('aria-label', 'DNX');

    for (let y = -PAD_Y; y < ROWS + PAD_Y; y++) {
      for (let x = -PAD_X; x < COLS + PAD_X; x++) {
        const key = (x + PAD_X) * 733 + (y + PAD_Y) * 7919 + this.seed;
        this.cells.push({
          x, y, key,
          char: LOGO_ROWS[y]?.[x] ?? ' ',
          // A weak left-to-right bias under a mostly random, per-cell lock.
          lockAt: 0.035 + random(key + 19) * 0.84 + ((x + PAD_X) / (COLS + PAD_X * 2)) * 0.11,
          shade: random(key + 151),
        });
      }
    }

    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motionReduced = this.media.matches;
    if (this.reducedMotion) this.elapsed = this.durationMs;
    this.media.addEventListener('change', this.onMotionChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('resize', this.resize);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas);
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(([entry]) => {
        this.inView = entry?.isIntersecting ?? true;
        this.syncLoop();
      });
      this.intersectionObserver.observe(canvas);
    }
    this.createPatterns();
    this.resize();
    if (options.autoplay !== false) this.play();
  }

  /** Visual reveal progress only; this is not your app's resource-loading progress. */
  get progress(): number {
    if (this.reducedMotion) return 1;
    if (this.resolveTween) {
      const t = this.resolveTween;
      return t.from + (1 - t.from) * smooth(t.duration === 0 ? 1 : (this.elapsed - t.at) / t.duration);
    }
    return this.durationMs === 0 ? 1 : clamp(this.elapsed / this.durationMs);
  }

  get timeMs(): number { return this.elapsed; }
  get isPlaying(): boolean { return this.playing && !this.disposed; }
  get reducedMotion(): boolean { return this.respectReducedMotion && this.motionReduced; }

  /** Resume, without restarting the reveal. Safe to call more than once. */
  play(): void {
    if (this.disposed) return;
    this.playing = true;
    this.paint();
    this.syncLoop();
  }

  pause(): void {
    this.playing = false;
    this.stopLoop();
  }

  restart(): void {
    if (this.disposed) return;
    this.seek(0);
    this.play();
  }

  /** Seek the visual timeline. Does not change the playing/paused state. */
  seek(timeMs: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(timeMs)) throw new TypeError('timeMs must be finite.');
    this.elapsed = Math.max(0, timeMs);
    this.resolveTween = null;
    this.lastTime = null;
    this.lastPaint = -Infinity;
    this.paint();
  }

  /** Resolve early, e.g. when application assets finish loading. Idle remains animated. */
  resolve(durationMs = 600): void {
    if (this.disposed) return;
    this.resolveTween = {
      at: this.elapsed,
      from: this.progress,
      duration: finite(durationMs, 600, 0, 120000),
    };
    this.play();
  }

  setIdleGlitch(value: number): void {
    if (this.disposed) return;
    this.idleGlitch = finite(value, 0.12, 0, 1);
    this.paint();
  }

  setGlow(value: number): void {
    if (this.disposed) return;
    this.glow = finite(value, 0.65, 0, 1);
    this.paint();
  }

  /** Cancel all animation and remove observers/listeners. Safe to call twice. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    this.media.removeEventListener('change', this.onMotionChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('resize', this.resize);
    for (const [name, value] of [['role', this.oldRole], ['aria-label', this.oldLabel]] as const) {
      if (value === null) this.canvas.removeAttribute(name);
      else this.canvas.setAttribute(name, value);
    }
    for (const surface of [this.ink, this.bloom, this.atlas]) surface.width = surface.height = 0;
    // Leave the last painted frame intact; the owning app controls DOM removal.
  }

  private readonly onVisibilityChange = (): void => { this.syncLoop(); };
  private readonly onMotionChange = (event: MediaQueryListEvent): void => {
    this.motionReduced = event.matches;
    // Do not replay the corruption if reduced motion is subsequently disabled.
    if (this.reducedMotion) {
      this.elapsed = this.durationMs;
      this.resolveTween = null;
    }
    this.paint();
    this.syncLoop();
  };

  private canAnimate(): boolean {
    return this.playing && !this.disposed && !this.reducedMotion &&
      !document.hidden && this.inView && this.width > 0 && this.height > 0;
  }

  private stopLoop(): void {
    if (this.raf !== null) window.cancelAnimationFrame(this.raf);
    this.raf = null;
    this.lastTime = null;
  }

  private syncLoop(): void {
    if (!this.canAnimate()) this.stopLoop();
    else if (this.raf === null) {
      this.lastTime = null;
      this.lastPaint = -Infinity;
      this.raf = window.requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = null;
    if (!this.canAnimate()) return;
    if (this.lastTime !== null) this.elapsed += Math.max(0, now - this.lastTime);
    this.lastTime = now;
    const interval = 1000 / this.fps;
    if (now - this.lastPaint >= interval - 0.5) {
      // Carry the fractional remainder so 30fps stays 30fps on 60/120Hz displays.
      const delta = now - this.lastPaint;
      this.lastPaint = Number.isFinite(delta)
        ? this.lastPaint + Math.max(1, Math.floor((delta + 0.5) / interval)) * interval
        : now;
      if (Math.min(window.devicePixelRatio || 1, this.maxDpr) !== this.dpr) this.resize();
      else this.paint();
    }
    if (this.canAnimate() && this.raf === null) this.raf = window.requestAnimationFrame(this.tick);
  };

  private readonly resize = (): void => {
    if (this.disposed) return;
    const box = this.canvas.getBoundingClientRect();
    this.width = box.width;
    this.height = box.height;
    if (this.width <= 0 || this.height <= 0) { this.syncLoop(); return; }
    this.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    this.ink.width = this.canvas.width;
    this.ink.height = this.canvas.height;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.inkCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.bloom.width = Math.max(1, Math.ceil(this.width / 3));
    this.bloom.height = Math.max(1, Math.ceil(this.height / 3));

    this.ctx.font = `100px ${FONT}`;
    const charRatio = this.ctx.measureText('M').width / 100;
    this.fontSize = Math.max(0.1, Math.min(
      this.width * 0.855 / (COLS * charRatio),
      this.height * 0.60 / (ROWS * 1.32),
    ));
    this.cellWidth = this.fontSize * charRatio;
    this.lineHeight = this.fontSize * 1.32;
    this.originX = (this.width - COLS * this.cellWidth) / 2;
    this.originY = (this.height - ROWS * this.lineHeight) / 2;
    this.buildAtlas();
    this.vignette = this.ctx.createRadialGradient(
      this.width / 2, this.height / 2, this.width * 0.09,
      this.width / 2, this.height / 2, Math.hypot(this.width, this.height) * 0.56,
    );
    this.vignette.addColorStop(0, 'rgba(0,0,0,0)');
    this.vignette.addColorStop(0.65, 'rgba(0,0,0,0.06)');
    this.vignette.addColorStop(1, 'rgba(0,0,0,0.56)');
    this.paint();
    this.syncLoop();
  };

  private buildAtlas(): void {
    const colors = [this.palette.dim, this.palette.muted, this.palette.foreground, this.palette.highlight];
    this.spritePad = Math.max(1, Math.ceil(this.fontSize * this.dpr * 0.35));
    this.spriteWidth = Math.ceil(this.cellWidth * this.dpr) + this.spritePad * 2;
    this.spriteHeight = Math.ceil(this.lineHeight * this.dpr) + this.spritePad * 2;
    this.atlas.width = GLYPHS.length * this.spriteWidth;
    this.atlas.height = colors.length * this.spriteHeight;
    const a = context(this.atlas);
    a.font = `400 ${this.fontSize * this.dpr}px ${FONT}`;
    a.textBaseline = 'top';
    for (let tone = 0; tone < colors.length; tone++) {
      a.fillStyle = colors[tone]!;
      for (let i = 0; i < GLYPHS.length; i++) {
        a.fillText(GLYPHS[i]!, i * this.spriteWidth + this.spritePad,
          tone * this.spriteHeight + this.spritePad);
      }
    }
  }

  private stamp(char: string, x: number, y: number, tone: number): void {
    const index = this.glyphIndex.get(char);
    if (index === undefined) return;
    this.inkCtx.drawImage(this.atlas,
      index * this.spriteWidth, tone * this.spriteHeight, this.spriteWidth, this.spriteHeight,
      x - this.spritePad / this.dpr, y - this.spritePad / this.dpr,
      this.spriteWidth / this.dpr, this.spriteHeight / this.dpr,
    );
  }

  private createPatterns(): void {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 128;
    const t = context(tile);
    const image = t.createImageData(128, 128);
    for (let i = 0; i < image.data.length; i += 4) {
      const n = Math.floor(80 + random(i + this.seed) * 150);
      image.data[i] = n * 0.62;
      image.data[i + 1] = n;
      image.data[i + 2] = n * 0.9;
      image.data[i + 3] = 255;
    }
    t.putImageData(image, 0, 0);
    this.noisePattern = this.ctx.createPattern(tile, 'repeat');
    const lines = document.createElement('canvas');
    lines.width = 1; lines.height = 4;
    const s = context(lines);
    s.fillStyle = 'rgba(0,0,0,0.18)';
    s.fillRect(0, 0, 1, 1);
    s.fillStyle = 'rgba(101,197,190,0.018)';
    s.fillRect(0, 2, 1, 1);
    this.scanPattern = this.ctx.createPattern(lines, 'repeat');
  }

  private paint(): void {
    if (this.disposed || this.width <= 0 || this.height <= 0) return;
    const ctx = this.ctx;
    const w = this.width, h = this.height;
    const time = this.reducedMotion ? this.durationMs : this.elapsed;
    const progress = this.progress;
    const reveal = smooth((progress - 0.10) / 0.90);
    const chaos = Math.pow(1 - reveal, 1.45);
    const idle = this.reducedMotion ? 0 : this.idleGlitch * smooth((progress - 0.72) / 0.28);
    const tick = Math.floor(time / (progress >= 1 ? 180 : 88));
    const slowTick = Math.floor(time / 380);
    const rowTick = Math.floor(time / 125);
    // Two small echoes every ~6 seconds, never a full-screen flash.
    const phase = (time + this.seed * 3) % 6100;
    const burst = idle * (Math.max(0, 1 - Math.abs(phase - 140) / 120) +
      0.45 * Math.max(0, 1 - Math.abs(phase - 380) / 65));
    const burstRow = Math.floor(random(Math.floor(time / 6100) + this.seed) * ROWS);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Backing sizes are rounded, so clear past fractional CSS edges as well.
    ctx.clearRect(0, 0, w + 1, h + 1);
    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, w + 1, h + 1);
    this.drawInterference(time, chaos, idle);

    const ink = this.inkCtx;
    ink.clearRect(0, 0, w + 1, h + 1);
    let previousRow = -999;
    let shiftX = 0, shiftY = 0;
    for (const cell of this.cells) {
      const { x, y, key } = cell;
      if (y !== previousRow) {
        previousRow = y;
        const rowKey = (y + PAD_Y) * 919 + rowTick * 311 + this.seed;
        const tearing = random(rowKey + 41) < 0.22 ? 2.4 : 1;
        shiftX = (random(rowKey) - 0.5) * this.cellWidth * 15 * chaos * tearing;
        shiftY = (random(rowKey + 11) - 0.5) * this.lineHeight * 1.8 * chaos * chaos;
        if (Math.abs(y - burstRow) <= 1) shiftX += (y % 2 ? -1 : 1) * burst * this.cellWidth * 1.6;
      }
      const locked = reveal >= cell.lockAt;
      const n = random(key + tick * 13007);
      let char: string;
      let tone: number;
      let alpha: number;
      if (locked) {
        char = cell.char;
        if (char === ' ') {
          // Quiet edge dust: a few punctuation marks just outside the solid strokes.
          const nearStroke = [LOGO_ROWS[y]?.[x - 1], LOGO_ROWS[y]?.[x + 1],
            LOGO_ROWS[y - 1]?.[x], LOGO_ROWS[y + 1]?.[x]]
            .some(c => c !== undefined && c !== ' ');
          if (cell.shade < 0.82 || !nearStroke) continue;
          ink.globalAlpha = 0.42;
          this.stamp(cell.shade > 0.93 ? ':' : '.',
            this.originX + x * this.cellWidth + shiftX,
            this.originY + y * this.lineHeight + shiftY, 0);
          continue;
        }
        tone = char === ':' || char === '.' ? 1 : (cell.shade > 0.80 || y < 2 ? 3 : 2);
        alpha = 0.86 + cell.shade * 0.14;
        // Static wear and extremely sparse, live substitutions preserve readability.
        if (char === '#' && cell.shade > 0.981) { char = '+'; tone = 2; }
        if (char === '#' && random(key + slowTick * 1103) < idle * 0.009) {
          char = '=+:'[Math.floor(n * 3)]!;
          tone = 1;
        }
      } else {
        // The first frame does not expose the letter silhouette: empty and occupied
        // cells have the same corruption density until that cell locks into place.
        if (n > 0.50 + chaos * 0.12) continue;
        char = SCRAMBLE[Math.floor(random(key + tick * 701 + 7) * SCRAMBLE.length)]!;
        tone = n < 0.055 ? 3 : (n < 0.30 ? 2 : 1);
        alpha = (0.24 + random(key + tick * 503) * 0.72) * (0.72 + chaos * 0.28);
      }
      ink.globalAlpha = alpha;
      this.stamp(char,
        this.originX + x * this.cellWidth + shiftX,
        this.originY + y * this.lineHeight + shiftY,
        tone,
      );
    }
    ink.globalAlpha = 1;

    // Whole-surface glow: no per-character shadowBlur cost.
    if (this.glow > 0) {
      const b = this.bloomCtx;
      b.clearRect(0, 0, this.bloom.width, this.bloom.height);
      b.shadowColor = this.palette.glow;
      b.shadowBlur = 3.5;
      b.drawImage(this.ink, 0, 0, this.bloom.width, this.bloom.height);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = this.glow * 0.54;
      ctx.drawImage(this.bloom, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
    // Faint displaced echoes; no red/blue aberration outside the chosen palette.
    if (chaos > 0.01 || idle > 0) {
      ctx.globalAlpha = chaos * 0.20 + idle * 0.10;
      ctx.drawImage(this.ink, this.cellWidth * (chaos * 3.7 + idle * 0.8), 0, w, h);
      ctx.globalAlpha = chaos * 0.11 + burst * 0.18;
      ctx.drawImage(this.ink, -this.cellWidth * (chaos * 2.5 + burst), 1, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(this.ink, 0, 0, w, h);

    // Thin displaced slices make the initial corruption look like broken video sync.
    const slices = chaos > 0.04 ? 4 : (burst > 0.015 ? 1 : 0);
    for (let i = 0; i < slices; i++) {
      const n = random(rowTick * 263 + i * 73 + this.seed);
      const y = this.originY + n * ROWS * this.lineHeight;
      const bandH = Math.min(h - y, Math.max(1, this.lineHeight * (0.08 + chaos * 0.5)));
      if (y < 0 || bandH <= 0) continue;
      const dx = (random(i * 31 + rowTick * 911) - 0.5) * this.cellWidth * (chaos * 18 + burst * 3);
      ctx.globalAlpha = 0.20 + chaos * 0.28;
      ctx.drawImage(this.ink, 0, y * this.dpr, this.ink.width, bandH * this.dpr,
        dx, y, w, bandH);
    }
    ctx.globalAlpha = 1;
    this.drawCRT(time, chaos);
  }

  private drawInterference(time: number, chaos: number, idle: number): void {
    const ctx = this.ctx;
    const tick = Math.floor(time / (chaos > 0.1 ? 100 : 430));
    // Final-state interference stays faint and does not obscure the letterforms.
    const count = Math.floor(38 + chaos * 64);
    for (let i = 0; i < count; i++) {
      const key = this.seed + i * 1357 + (chaos > 0.02 ? tick * 733 : Math.floor(tick / 4) * 193);
      const x = random(key + 1) * this.width;
      const y = random(key + 3) * this.height;
      const length = (3 + random(key + 7) * 115) * (0.48 + chaos);
      ctx.fillStyle = i % 5 ? this.palette.muted : this.palette.glow;
      ctx.globalAlpha = (0.055 + random(key + 11) * 0.15) * (0.70 + chaos * 1.55 + idle);
      const pieces = 2 + Math.floor(random(key + 13) * 5);
      for (let part = 0; part < pieces; part++) {
        const pw = length / pieces;
        ctx.fillRect(x + part * (pw + 3), y, pw, (i % 7 === 0 && chaos > 0.2) ? 2 : 0.8);
      }
    }
    const traces = [[5, -7, 12], [10, 24, 13], [14, 68, 15], [4, 96, 12], [18, 37, 9], [17, -5, 10]];
    ctx.fillStyle = this.palette.glow;
    for (let i = 0; i < traces.length; i++) {
      const [row, col, length] = traces[i]!;
      const y = this.originY + (row! + 0.65) * this.lineHeight;
      const x = this.originX + col! * this.cellWidth;
      const pulse = 0.76 + Math.sin(time / 1500 + i * 2.7) * 0.24;
      ctx.globalAlpha = (0.22 + chaos * 0.20) * pulse;
      for (let piece = 0; piece < length!; piece++) {
        if (random(i * 413 + piece + this.seed) > 0.8) continue;
        ctx.fillRect(x + piece * this.cellWidth, y, this.cellWidth * 0.76, Math.max(0.7, this.fontSize * 0.065));
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawCRT(time: number, chaos: number): void {
    const ctx = this.ctx;
    if (this.noisePattern) {
      ctx.fillStyle = this.noisePattern;
      ctx.globalAlpha = 0.018 + chaos * 0.025;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    ctx.globalAlpha = 1;
    if (this.hasScanlines && this.scanPattern) {
      ctx.fillStyle = this.scanPattern;
      ctx.fillRect(0, 0, this.width, this.height);
      if (!this.reducedMotion) {
        const bandY = ((time / 13000) % 1) * (this.height + 140) - 140;
        const band = ctx.createLinearGradient(0, bandY, 0, bandY + 140);
        band.addColorStop(0, 'rgba(101,197,190,0)');
        band.addColorStop(0.5, 'rgba(101,197,190,0.027)');
        band.addColorStop(1, 'rgba(101,197,190,0)');
        ctx.fillStyle = band;
        ctx.fillRect(0, Math.max(0, bandY), this.width, 140);
      }
    }
    if (this.vignette) {
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }
}
