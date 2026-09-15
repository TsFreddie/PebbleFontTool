/**
 * Thin stem widening pass (runs after `capStems`).
 *
 * The cap pass removes one layer from 3px+ stems, but the same autohinter also
 * lands strokes at 1px, which reads as unevenly light. This pass widens those,
 * under rules that keep the glyph from turning into a blob:
 *
 *   1. only straight, axis-aligned 1px stems are considered - a run of length 1
 *      whose perpendicular run is at least `minPerp` and whose position holds
 *      for at least `minStem` consecutive lines. Dots, stubs and diagonals are
 *      left alone;
 *   2. the white gap on either side is measured along the cross section, up to
 *      the next ink pixel, with anything outside the bitmap counting as ink (so
 *      a stroke on the glyph's edge has no white on that side and the ink bbox
 *      cannot grow);
 *   3. the gap is taken as the *minimum* over the whole stem, so a stem is
 *      filled in full or not at all - never partially, which would show up as a
 *      step;
 *   4. a fill is legal when the remaining white space is at least 2px for a
 *      vertical stem and 1px for a horizontal one. Of the legal sides the one
 *      with the larger gap is filled, which makes the two sides more even;
 *      a tie (or no gap at all) falls back to the left side (up for horizontal);
 *   5. a stem is only committed if the glyph's components and holes survive,
 *      the same guard the cap pass uses.
 */

import {
  bitmapToShape,
  type Bitmap,
  type BitmapRuns,
  runLengths,
  shapeToBitmap,
} from "./stem_cap";

export type StemWidenSide = "uniform" | "tight" | "left" | "right";

export interface StemWidenOptions {
  /** How far a stem must run for its cross section to count (default 4). */
  minPerp?: number;
  /** How many lines a stem must hold its position (default 2). */
  minStem?: number;
  /** Increment from `capStems`, so the glyph cannot grow out of the bitmap. */
  grow?: boolean;
  /**
   * Which legal side to fill. `uniform` takes the larger gap (the two sides end
   * up closer in size), `tight` the smaller one, `left`/`right` always the same
   * side (up/down for horizontal stems). Defaults to `uniform`.
   */
  side?: StemWidenSide;
}

export interface StemWidenResult {
  bitmap: Bitmap;
  /** stems that got a second pixel */
  widened: number;
  /** stems that were left at 1px (no side had room) */
  skipped: number;
}

interface Stem {
  axis: 0 | 1;
  line: number;
  /** the cross section offset along the line */
  offset: number;
}

const at = (axis: 0 | 1, line: number, offset: number, width: number) =>
  axis === 0 ? line * width + offset : offset * width + line;

/**
 * Ink pixels within `reach` 8-connected steps of the stem's cross sections: the
 * ink that belongs to the same little cluster as the stroke. A fill may close
 * the white between the stem and such ink (the dot of a radical touching its
 * first bar) even though it leaves no white, because the design has them joined.
 */
function attachedInk(bitmap: Bitmap, axis: 0 | 1, stem: Stem[], reach = 3) {
  const { ink, width, height } = bitmap;
  const seen = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const s of stem) {
    const p = at(axis, s.line, s.offset, width);
    if (ink[p] && !seen[p] && !queue.includes(p)) {
      seen[p] = 1;
      queue.push(p);
    }
  }
  for (let head = 0, depth = 1; head < queue.length; depth += 1) {
    const end = queue.length;
    if (depth > reach) break;
    for (; head < end; head++) {
      const p = queue[head]!;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (ink[q] && !seen[q]) {
            seen[q] = 1;
            queue.push(q);
          }
        }
      }
    }
  }
  return seen;
}

/** consecutive background pixels from `p` towards `step` (out of bounds = ink) */
function gap(
  bitmap: Bitmap,
  axis: 0 | 1,
  line: number,
  offset: number,
  step: number,
) {
  const { ink, width } = bitmap;
  const along = axis === 0 ? width : bitmap.height;
  let count = 0;
  for (let t = offset + step; t >= 0 && t < along; t += step) {
    if (ink[at(axis, line, t, width)]) break;
    count += 1;
  }
  return count;
}

/** where the run towards `step` first hits ink, or -1 when it runs out */
function firstInk(
  bitmap: Bitmap,
  axis: 0 | 1,
  line: number,
  offset: number,
  step: number,
) {
  const { ink, width } = bitmap;
  const along = axis === 0 ? width : bitmap.height;
  for (let t = offset + step; t >= 0 && t < along; t += step) {
    const p = at(axis, line, t, width);
    if (ink[p]) return p;
  }
  return -1;
}

export function widenStems(
  source: Bitmap,
  options: StemWidenOptions = {},
): StemWidenResult {
  const minPerp = options.minPerp ?? 4;
  const minStem = options.minStem ?? 2;
  const side = options.side ?? "uniform";
  const { width, height } = source;
  const grown = new Uint8Array(width * height);
  let widened = 0;
  let skipped = 0;

  for (const axis of [0, 1] as const) {
    const axisRuns: BitmapRuns = runLengths(source, axis);
    const lines = axis === 0 ? height : width;
    const along = axis === 0 ? width : height;

    // candidate cross sections: a lone pixel in a long run
    const candidates: Stem[] = [];
    for (let line = 0; line < lines; line++) {
      for (let offset = 0; offset < along; offset++) {
        const p = at(axis, line, offset, width);
        if (!source.ink[p]) continue;
        if (axisRuns.along.length[p] !== 1) continue;
        if (axisRuns.perp.length[p]! < minPerp) continue;
        candidates.push({ axis, line, offset });
      }
    }

    // One stroke is one stem: a crossing splits the cross sections into several
    // chains, but they share the same straight run, so they must be collected
    // and decided together - otherwise two chains of one bar pick two different
    // sides and the bar ends up three pixels thick.
    const runs = new Map<string, Stem[]>();
    for (const candidate of candidates) {
      const p = at(axis, candidate.line, candidate.offset, width);
      const perpStart = axisRuns.perp.start[p]!;
      const perpLength = axisRuns.perp.length[p]!;
      const key = `${candidate.offset}:${perpStart}:${perpLength}`;
      const list = runs.get(key) ?? [];
      list.push(candidate);
      runs.set(key, list);
    }

    for (const crossSections of runs.values()) {
      if (crossSections.length < minStem) continue;
      // the whole straight run, crossings included
      const first = crossSections[0]!;
      const runStart =
        axisRuns.perp.start[at(axis, first.line, first.offset, width)]!;
      const runLength =
        axisRuns.perp.length[at(axis, first.line, first.offset, width)]!;
      const lines: Stem[] = [];
      for (let i = 0; i < runLength; i++) {
        lines.push({ axis, line: runStart + i, offset: first.offset });
      }
      const usable = lines.filter(
        (s) => source.ink[at(axis, s.line, s.offset, width)],
      );
      if (usable.length < minStem) continue;
      // Only the lines where the side is actually white get a pixel, and only
      // those decide legality: a crossing or a neighbouring stroke is ink there
      // already and is neither filled nor asked to keep white space.
      const fillable = (step: number) =>
        usable.filter((s) => {
          const p = at(axis, s.line, s.offset + step, width);
          return !source.ink[p] && !grown[p];
        });
      const lowestGap = (step: number) => {
        const targets = fillable(step);
        if (!targets.length) return -1;
        return Math.min(
          ...targets.map((s) => gap(source, axis, s.line, s.offset, step)),
        );
      };
      const attached = attachedInk(source, axis, usable);
      const left = lowestGap(-1);
      const right = lowestGap(1);
      // vertical stems keep 2px of white, horizontal ones 1px - unless the ink
      // in the way is attached to the stroke, which means the pieces are one
      // stroke in the design and closing the gap only joins what is joined
      const joining = (step: number) =>
        fillable(step).some((s) => {
          const p = firstInk(source, axis, s.line, s.offset, step);
          return (
            p >= 0 &&
            attached[p] === 1 &&
            gap(source, axis, s.line, s.offset, step) === 1
          );
        });
      const keep = axis === 0 ? 2 : 1;
      const legalLeft = left >= keep + 1 || (left >= 1 && joining(-1));
      const legalRight = right >= keep + 1 || (right >= 1 && joining(1));
      if (!legalLeft && !legalRight) {
        skipped += 1;
        continue;
      }
      let step = 1;
      if (legalLeft && legalRight) {
        if (side === "left") step = -1;
        else if (side === "right") step = 1;
        else if (side === "tight")
          step = left < right ? -1 : right < left ? 1 : -1;
        else step = left > right ? -1 : right > left ? 1 : -1;
      } else {
        step = legalLeft ? -1 : 1;
      }
      const trial = new Uint8Array(width * height);
      for (const s of fillable(step)) {
        trial[at(axis, s.line, s.offset + step, width)] = 1;
      }
      if (!trial.some((v) => v)) {
        skipped += 1;
        continue;
      }
      // A fill that would trap a white pinhole against a neighbouring stroke
      // (the last bar of a radical meeting its dot, say) absorbs the pinhole
      // instead of backing off: in the design those pieces are one stroke, and a
      // 1px speck of white inside the ink reads as noise.
      const filled = Uint8Array.from(source.ink, (v, p) =>
        v || grown[p] || trial[p] ? 1 : 0,
      );
      let absorbed = true;
      while (absorbed) {
        absorbed = false;
        for (let p = 0; p < filled.length; p++) {
          if (filled[p]) continue;
          const x = p % width;
          const y = (p - x) / width;
          const enclosed = (a: Uint8Array) =>
            (x === 0 || a[p - 1] === 1) &&
            (x === width - 1 || a[p + 1] === 1) &&
            (y === 0 || a[p - width] === 1) &&
            (y === height - 1 || a[p + width] === 1);
          // a speck the source already enclosed is part of the design: leave it
          if (enclosed(filled) && !enclosed(source.ink)) {
            trial[p] = 1;
            filled[p] = 1;
            absorbed = true;
          }
        }
      }
      // Widening is allowed to join pieces of one stroke (the reference does),
      // so only new holes would matter - and the loop above rules those out.
      for (let p = 0; p < trial.length; p++) if (trial[p]) grown[p] = 1;
      widened += 1;
    }
  }

  const ink = Uint8Array.from(source.ink, (v, p) => (v || grown[p] ? 1 : 0));
  return { bitmap: { ink, width, height }, widened, skipped };
}

/** Convenience wrapper for the `#`/space shape strings the extractor writes. */
export function widenShape(
  shape: string,
  options: StemWidenOptions = {},
): { shape: string; widened: number; skipped: number } {
  const { bitmap, widened, skipped } = widenStems(
    shapeToBitmap(shape),
    options,
  );
  return { shape: bitmapToShape(bitmap), widened, skipped };
}
