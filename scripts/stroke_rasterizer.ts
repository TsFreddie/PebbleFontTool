/**
 * Stroke-normalizing rasterizer.
 *
 * FreeType (even with its autohinter) renders CJK stems at a mix of 1, 2 and
 * 3 pixels: the autohinter only *prefers* the standard stem width, and hinting
 * moves individual stems around, so neighbouring strokes end up visibly
 * different.
 *
 * This rasterizer keeps the shape of the glyph and normalizes the width of its
 * stems:
 *
 *   1. render the outline at `supersample` x the target size, unhinted, and
 *      box downsample it to a coverage bitmap;
 *   2. take 50% coverage as the reference bitmap. It has the right shape -
 *      corners, joins, diagonals, counters - but stems come out 1 to 3 pixels
 *      wide depending on where they happen to fall on the pixel grid;
 *   3. scan every row and column. A short run (1..3 pixels) whose pixels are
 *      part of a long perpendicular run is a stem cross section: replace it
 *      with the best `strokeWidth` consecutive pixels of the cross section as
 *      measured by the coverage, or with a single pixel when the cross section
 *      carries less than 1.7 pixels of ink. Long runs are stroke bodies,
 *      diagonals, joins and filled areas and are left alone;
 *   4. repeat both scans until they settle.
 *
 * Stems end up 2px wide wherever the glyph has room, 1px where it is thin or
 * crowded, never 3px - while the reference shape survives, so there are no
 * chipped corners, no shifted strokes and no lost counters.
 */
import freetype from "freetype2";

export interface StrokeRasterOptions {
  /** Rasterize at this many pixels per target pixel (default 8). */
  supersample?: number;
  /** Width (in target pixels) of an uncrowded stem (default 2). */
  strokeWidth?: number;
  /** Width (in target pixels) of a thin stem (default 1). */
  thinWidth?: number;
  /** Maximum normalization passes (default 4). */
  maxPasses?: number;
  /** Include the reference bitmap in the result (default false). */
  debug?: boolean;
}

export interface StrokeRasterStats {
  /** target size of the reference and of the result, in pixels */
  width: number;
  height: number;
  /** runs that were replaced by a differently sized window */
  changed: number;
  passes: number;
  components: number;
  holes: number;
  referenceComponents: number;
  referenceHoles: number;
}

export interface StrokeRasterResult {
  shape: string;
  top: number;
  left: number;
  advance: number;
  width: number;
  height: number;
  stats: StrokeRasterStats;
  /** only present with the `debug` option */
  debug?: { reference: string; left: number; top: number; edits: string[] };
}

const KEY_BIAS = 4096;
const KEY_STRIDE = 8192;

const key = (p: number, q: number) =>
  (p + KEY_BIAS) * KEY_STRIDE + (q + KEY_BIAS);
const keyX = (k: number) => Math.floor(k / KEY_STRIDE) - KEY_BIAS;
const keyY = (k: number) => (k % KEY_STRIDE) - KEY_BIAS;

/**
 * Ink carried by a cross section below which it renders as a single pixel.
 * 1.5 is round-to-nearest, so the only cross sections that stay 1px are the
 * genuinely thin ones.
 */
const THIN_MASS = 1.5;
/** A pixel may only be added to a stem when the reference ink reaches this. */
const MIN_ADD_COVERAGE = 0.2;

interface Topology {
  components: number;
  holes: number;
}

function topology(bit: Uint8Array, w: number, h: number): Topology {
  const seen = new Uint8Array(w * h);
  let components = 0;

  // ink: 8-connected
  for (let i = 0; i < w * h; i++) {
    if (!bit[i] || seen[i]) continue;
    components++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (bit[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
  }

  // background: 4-connected, flood from the border; anything left is a hole
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!bit[p] && !outside[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  let holes = 0;
  for (let i = 0; i < w * h; i++) {
    if (!bit[i] && !outside[i]) {
      holes++;
      const inner = [i];
      outside[i] = 1;
      while (inner.length) {
        const p = inner.pop()!;
        const x = p % w;
        const y = (p - x) / w;
        if (x > 0 && !bit[p - 1] && !outside[p - 1]) {
          outside[p - 1] = 1;
          inner.push(p - 1);
        }
        if (x < w - 1 && !bit[p + 1] && !outside[p + 1]) {
          outside[p + 1] = 1;
          inner.push(p + 1);
        }
        if (y > 0 && !bit[p - w] && !outside[p - w]) {
          outside[p - w] = 1;
          inner.push(p - w);
        }
        if (y < h - 1 && !bit[p + w] && !outside[p + w]) {
          outside[p + w] = 1;
          inner.push(p + w);
        }
      }
    }
  }

  return { components, holes };
}

export function rasterizeStroke(
  face: freetype.FontFace,
  codePoint: number,
  renderWidth: number,
  renderHeight: number,
  options: StrokeRasterOptions = {},
): StrokeRasterResult | false {
  const S = options.supersample ?? 8;
  const WIDE = options.strokeWidth ?? 2;
  const THIN = options.thinWidth ?? 1;
  const maxPasses = options.maxPasses ?? 4;

  const index = face.getCharIndex(codePoint);
  if (!index) {
    return false;
  }

  // ---- 1. high resolution, unhinted mask -------------------------------
  face.setTransform(undefined, undefined);
  face.setPixelSizes(renderWidth * S, renderHeight * S);

  const glyph = face.loadGlyph(index, {
    forceAutohint: false,
    noHinting: true,
    loadTarget: freetype.RenderMode.MONO,
    monochrome: true,
    render: true,
  });

  const bitmap = glyph.bitmap;
  if (!bitmap || !bitmap.width || !bitmap.height) {
    return false;
  }

  const advance = glyph.metrics.horiAdvance / 64 / S;
  const bitmapLeft = glyph.bitmapLeft ?? 0;
  const bitmapTop = glyph.bitmapTop ?? 0;

  const toU = (x: number) => (bitmapLeft + x + 0.5) / S;
  const toV = (y: number) => renderHeight - (bitmapTop - y - 0.5) / S;

  // ---- 2. coverage and the reference bitmap ----------------------------
  const coverage = new Map<number, number>();
  let ink = 0;
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      const byte = bitmap.buffer[y * bitmap.pitch + (x >> 3)];
      if (byte === undefined || !(byte & (1 << (7 - (x & 7))))) continue;
      ink++;
      const k = key(Math.floor(toU(x)), Math.floor(toV(y)));
      coverage.set(k, (coverage.get(k) ?? 0) + 1);
    }
  }

  if (!ink) {
    return false;
  }

  const perPixel = 1 / (S * S);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [k, count] of coverage) {
    const c = count * perPixel;
    coverage.set(k, Math.min(1, c));
    if (c < 0.02) continue;
    const x = keyX(k);
    const y = keyY(k);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // one pixel of margin for windows that grow the run, then another for the
  // neighbourhood used by the run length tests
  minX -= 2;
  minY -= 2;
  maxX += 2;
  maxY += 2;

  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  const cov = new Float32Array(W * H);
  const index2 = (x: number, y: number) => y * W + x;
  for (const [k, c] of coverage) {
    const x = keyX(k) - minX;
    const y = keyY(k) - minY;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    cov[index2(x, y)] = c;
  }

  const reference = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (cov[i]! >= 0.5) reference[i] = 1;
  }

  // ---- 3. normalize the stem cross sections ----------------------------
  const bit = new Uint8Array(reference);

  const runLengths = () => {
    const rowRun = new Int32Array(W * H);
    const colRun = new Int32Array(W * H);
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!bit[index2(x, y)]) {
          x++;
          continue;
        }
        let end = x;
        while (end < W && bit[index2(end, y)]) end++;
        for (let i = x; i < end; i++) rowRun[index2(i, y)] = end - x;
        x = end;
      }
    }
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        if (!bit[index2(x, y)]) {
          y++;
          continue;
        }
        let end = y;
        while (end < H && bit[index2(x, end)]) end++;
        for (let i = y; i < end; i++) colRun[index2(x, i)] = end - y;
        y = end;
      }
    }
    return { rowRun, colRun };
  };

  let changed = 0;
  let passes = 0;

  const edits: string[] | undefined = options.debug ? [] : undefined;

  const SMOOTH_RADIUS = options.smoothRadius ?? 4;

  const smoothedCoverage = (horizontal: boolean) => {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let count = 0;
        for (let d = -SMOOTH_RADIUS; d <= SMOOTH_RADIUS; d++) {
          const nx = horizontal ? x : x + d;
          const ny = horizontal ? y + d : y;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          sum += cov[index2(nx, ny)]!;
          count++;
        }
        out[index2(x, y)] = sum / count;
      }
    }
    return out;
  };

  interface Edit {
    line: number;
    from: number;
    to: number;
    start: number;
    want: number;
  }

  const applyEdits = (
    target: Uint8Array,
    edits: Edit[],
    horizontal: boolean,
  ) => {
    const along = horizontal ? W : H;
    const at = (line: number, t: number) =>
      horizontal ? index2(t, line) : index2(line, t);
    for (const edit of edits) {
      for (let t = edit.from; t <= edit.to; t++) {
        target[at(edit.line, t)] = 0;
      }
      for (let k = 0; k < edit.want; k++) {
        target[at(edit.line, edit.start + k)] = 1;
      }
      void along;
    }
  };

  interface Run {
    line: number;
    a: number;
    b: number;
  }

  const scan = (horizontal: boolean): Edit[] => {
    const { rowRun, colRun } = runLengths();
    const smooth = smoothedCoverage(horizontal);
    const found: Edit[] = [];
    const lines = horizontal ? H : W;
    const along = horizontal ? W : H;
    const at = (line: number, t: number) =>
      horizontal ? index2(t, line) : index2(line, t);
    const runAt = (p: number) => (horizontal ? colRun[p]! : rowRun[p]!);

    // collect the runs of every scan line
    const runsAt: Run[][] = [];
    for (let line = 0; line < lines; line++) {
      const list: Run[] = [];
      let a = 0;
      while (a < along) {
        if (!bit[at(line, a)]) {
          a++;
          continue;
        }
        let b = a;
        while (b < along && bit[at(line, b)]) b++;
        list.push({ line, a, b });
        a = b;
      }
      runsAt.push(list);
    }

    // Chain runs that continue each other into strokes, so every cross section
    // of one stroke gets the same width and the same offset. Deciding per line
    // instead makes a stroke wobble, which reads as spikes sticking out.
    const groups: Run[][] = [];
    const ribbon: number[][] = [];
    for (let line = 0; line < lines; line++) {
      ribbon.push([]);
      for (const run of runsAt[line]!) {
        let id = -1;
        if (line > 0) {
          const previous = runsAt[line - 1]!;
          for (let j = 0; j < previous.length; j++) {
            const other = previous[j]!;
            if (
              Math.abs(other.a - run.a) <= 2 &&
              Math.abs(other.b - other.a - (run.b - run.a)) <= 1
            ) {
              id = ribbon[line - 1]![j]!;
              break;
            }
          }
        }
        if (id < 0) {
          id = groups.length;
          groups.push([]);
        }
        ribbon[line]!.push(id);
        groups[id]!.push(run);
      }
    }

    // best window of `want` pixels for one cross section, or null when the
    // cross section cannot carry it
    const bestWindow = (run: Run, want: number) => {
      const len = run.b - run.a;
      const widen = want > len;
      if (!widen && want === len) return null;
      const from = widen ? Math.max(0, run.a - 1) : run.a;
      const to = widen ? Math.min(along - 1, run.b) : run.b - want;
      let bestStart = -1;
      let bestScore = -1;
      for (let s = from; s + want - 1 <= to; s++) {
        let score = 0;
        let allowed = true;
        for (let k = 0; k < want; k++) {
          const t = s + k;
          const value = smooth[at(run.line, t)]!;
          if (t < run.a || t >= run.b) {
            // Only add ink where the reference ink nearly reaches, and never
            // grow into another stroke: the reference must be background one
            // pixel further out.
            const beyond = t < run.a ? t - 1 : t + 1;
            const beyondInk =
              beyond >= 0 &&
              beyond < along &&
              reference[at(run.line, beyond)] === 1;
            if (value < MIN_ADD_COVERAGE || beyondInk) {
              allowed = false;
              break;
            }
          }
          score += value;
        }
        if (!allowed) continue;
        if (score > bestScore) {
          bestScore = score;
          bestStart = s;
        }
      }
      return bestStart < 0 ? null : { start: bestStart, score: bestScore };
    };

    for (const group of groups) {
      const runs = group.filter((run) => {
        const len = run.b - run.a;
        return len === 1 || len === 3;
      });
      if (!runs.length) continue;

      // how many cross sections look like a stem at all
      let eligible = 0;
      for (const run of runs) {
        let perp = Infinity;
        for (let t = run.a; t < run.b; t++) {
          const value = runAt(at(run.line, t));
          if (value < perp) perp = value;
        }
        const outside =
          (run.a > 0 ? cov[at(run.line, run.a - 1)]! : 0) < 0.5 &&
          (run.b < along ? cov[at(run.line, run.b)]! : 0) < 0.5;
        if (outside && perp >= run.b - run.a + 1) eligible++;
      }
      if (eligible * 2 < runs.length) continue;

      // one width for the whole stroke
      const masses: number[] = [];
      for (const run of runs) {
        const from = Math.max(0, run.a - 1);
        const to = Math.min(along - 1, run.b);
        let mass = 0;
        for (let t = from; t <= to; t++) mass += smooth[at(run.line, t)]!;
        masses.push(mass);
      }
      masses.sort((p, q) => p - q);
      const mass = masses[Math.floor(masses.length / 2)]!;
      const want = mass >= THIN_MASS ? WIDE : THIN;

      // and one offset, so the stroke cannot jitter
      const offsets: number[] = [];
      for (const run of runs) {
        const window = bestWindow(run, want);
        if (window) offsets.push(window.start - run.a);
      }
      offsets.sort((p, q) => p - q);
      const offset = offsets.length
        ? offsets[Math.floor((offsets.length - 1) / 2)]!
        : 0;

      for (const run of runs) {
        const len = run.b - run.a;
        if (want === len) continue;
        const from = want > len ? Math.max(0, run.a - 1) : run.a;
        const to = want > len ? Math.min(along - 1, run.b) : run.b - want;
        const start = Math.max(from, Math.min(to, run.a + offset));
        const window = bestWindow(run, want);
        if (!window) continue;
        let differs = false;
        for (let t = run.a; t < run.b; t++) {
          const inWindow = t >= start && t < start + want;
          if (bit[at(run.line, t)] !== (inWindow ? 1 : 0)) differs = true;
        }
        if (!differs) continue;

        if (edits) {
          const lineBox = run.line + (horizontal ? minY : minX);
          const aBox = run.a + (horizontal ? minX : minY);
          edits.push(
            `${horizontal ? "row" : "col"} ${lineBox} at ${aBox} len=${len} want=${want} start=${start + (horizontal ? minX : minY)}`,
          );
        }
        found.push({
          line: run.line,
          from,
          to: Math.max(to, run.b),
          start,
          want,
        });
      }
    }

    return found;
  };

  const referenceTopology = topology(reference, W, H);
  const keepsTopology = (candidate: Uint8Array) => {
    const t = topology(candidate, W, H);
    return (
      t.components >= referenceTopology.components &&
      t.holes >= referenceTopology.holes
    );
  };

  for (let pass = 0; pass < maxPasses; pass++) {
    const rowEdits = scan(true);
    const colEdits = scan(false);
    if (!rowEdits.length && !colEdits.length) break;

    const trial = new Uint8Array(bit);
    applyEdits(trial, rowEdits, true);
    applyEdits(trial, colEdits, false);

    if (keepsTopology(trial)) {
      bit.set(trial);
      changed += rowEdits.length + colEdits.length;
    } else {
      // keep only the edits that do not cost a counter or a component
      for (const [edits, horizontal] of [
        [rowEdits, true],
        [colEdits, false],
      ] as const) {
        for (const edit of edits) {
          const single = new Uint8Array(bit);
          applyEdits(single, [edit], horizontal);
          if (keepsTopology(single)) {
            bit.set(single);
            changed++;
          }
        }
      }
      // nothing left to try: stop
      const again = new Uint8Array(bit);
      applyEdits(again, scan(true), true);
      applyEdits(again, scan(false), false);
      if (again.every((v, i) => v === bit[i])) break;
    }
    passes++;
  }

  // ---- output -----------------------------------------------------------
  let outMinX = Infinity;
  let outMinY = Infinity;
  let outMaxX = -Infinity;
  let outMaxY = -Infinity;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!bit[index2(x, y)]) continue;
      const px = x + minX;
      const py = y + minY;
      if (px < outMinX) outMinX = px;
      if (px > outMaxX) outMaxX = px;
      if (py < outMinY) outMinY = py;
      if (py > outMaxY) outMaxY = py;
    }
  }

  if (outMaxX < outMinX) {
    return false;
  }

  const rows: string[] = [];
  for (let y = outMinY; y <= outMaxY; y++) {
    let line = "";
    for (let x = outMinX; x <= outMaxX; x++) {
      line += bit[index2(x - minX, y - minY)] ? "#" : " ";
    }
    rows.push(line.trimEnd());
  }

  const result_topology = topology(bit, W, H);

  let debug:
    | { reference: string; left: number; top: number; edits: string[] }
    | undefined;
  if (options.debug) {
    let refMinX = Infinity;
    let refMinY = Infinity;
    let refMaxX = -Infinity;
    let refMaxY = -Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!reference[index2(x, y)]) continue;
        if (x < refMinX) refMinX = x;
        if (x > refMaxX) refMaxX = x;
        if (y < refMinY) refMinY = y;
        if (y > refMaxY) refMaxY = y;
      }
    }
    const referenceRows: string[] = [];
    for (let y = refMinY; y <= refMaxY; y++) {
      let line = "";
      for (let x = refMinX; x <= refMaxX; x++) {
        line += reference[index2(x, y)] ? "#" : " ";
      }
      referenceRows.push(line.trimEnd());
    }
    debug = {
      reference: referenceRows.join("\n"),
      left: refMinX + minX,
      top: refMinY + minY,
      edits,
    };
  }

  return {
    shape: rows.join("\n"),
    top: outMinY,
    left: outMinX,
    advance,
    width: outMaxX - outMinX + 1,
    height: outMaxY - outMinY + 1,
    debug,
    stats: {
      width: W,
      height: H,
      changed,
      passes,
      components: result_topology.components,
      holes: result_topology.holes,
      referenceComponents: referenceTopology.components,
      referenceHoles: referenceTopology.holes,
    },
  };
}
