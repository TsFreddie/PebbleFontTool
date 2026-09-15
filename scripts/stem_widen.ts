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
  /** Width to bring thin stems up to (default 2). */
  target?: number;
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

/** consecutive background pixels from `p` towards `step` (out of bounds = ink) */
function gap(
  bitmap: Bitmap,
  axis: 0 | 1,
  line: number,
  offset: number,
  step: number,
  extra?: Uint8Array,
) {
  const { ink, width } = bitmap;
  const along = axis === 0 ? width : bitmap.height;
  let count = 0;
  for (let t = offset + step; t >= 0 && t < along; t += step) {
    const p = at(axis, line, t, width);
    // pixels an earlier stem already filled count as ink, so two stems facing
    // each other across a gap cannot both eat into it
    if (ink[p] || extra?.[p]) break;
    count += 1;
  }
  return count;
}

export function widenStems(
  source: Bitmap,
  options: StemWidenOptions = {},
): StemWidenResult {
  const target = options.target ?? 2;
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
        const crossWidth = axisRuns.along.length[p]!;
        if (crossWidth < 1 || crossWidth >= target) continue;
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
          ...targets.map((s) =>
            gap(source, axis, s.line, s.offset, step, grown),
          ),
        );
      };
      // how many pixels this stroke still needs to reach the target width
      const grow = Math.max(
        1,
        target -
          Math.min(
            ...usable.map(
              (s) => axisRuns.along.length[at(axis, s.line, s.offset, width)]!,
            ),
          ),
      );
      // vertical stems keep 2px of white, horizontal ones 1px
      const left = lowestGap(-1);
      const right = lowestGap(1);
      const keep = axis === 0 ? 2 : 1;
      const legalLeft = left >= keep + grow;
      const legalRight = right >= keep + grow;
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
        for (let k = 1; k <= grow; k++) {
          const p = at(axis, s.line, s.offset + step * k, width);
          if (p >= 0 && p < trial.length && !source.ink[p]) trial[p] = 1;
        }
      }
      if (!trial.some((v) => v)) {
        skipped += 1;
        continue;
      }
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
