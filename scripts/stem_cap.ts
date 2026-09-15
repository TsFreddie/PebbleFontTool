/**
 * Stem cap pass.
 *
 * The autohinter lands the same stroke at 2px most of the time and at 3px (or
 * 4px) where the outline falls unluckily on the pixel grid, which reads as
 * inconsistent weight inside a single glyph. This pass takes one layer off
 * those thick stems and leaves everything else alone:
 *
 *   1. scan every row and column for runs of `minLength`..`maxWidth` pixels
 *      whose perpendicular run is at least `minPerp` long and whose pixels all
 *      share that one perpendicular run: those are cross sections of straight
 *      stems. The shared-run test rejects the column of a stem that runs into
 *      a 1px bar, where bar and stem together look like one thick stroke;
 *   2. chain cross sections that repeat with the *same* span for at least
 *      `minStem` consecutive lines. A diagonal drifts one pixel per line, so it
 *      is not a stem and stays untouched;
 *   3. remove the trailing edge of the cross section and walk that edge along
 *      the stem in both directions, through crossings. The walk stops at a
 *      pixel that is interior to a perpendicular run (inside a crossing
 *      stroke), that is not at the end of its own run, or where either axis is
 *      thinner than `minLength` - that is what keeps junctions, neighbouring
 *      2px stems, stroke ends and shallow diagonals intact. A stop caused by
 *      ink whose own run is already thinner than `minLength` abandons the
 *      group instead: the edge carries on thinner there, and shaving only the
 *      thick part of it leaves a jog;
 *   4. commit a stem only if the glyph's 8-connected components *and* holes are
 *      unchanged, so no counter can close and no stroke can be cut.
 *
 * The result is the glyph the pack would have had at a 2px nominal stem: the
 * shape, corners and joins of the reference survive, only the extra pixel of a
 * 3px+ stem disappears.
 */

export interface StemCapOptions {
  /** Width to leave stems at (default 2): 3px+ stems lose a layer. */
  target?: number;
  /** Narrowest cross section that is a stem (default target + 1). */
  minLength?: number;
  /** Widest cross section this pass will cap (default 4). */
  maxWidth?: number;
  /** How far a stem must run for its cross section to count (default 4). */
  minPerp?: number;
  /** How many lines a stem must hold its span (default 2). */
  minStem?: number;
}

/** One glyph's bitmap: `width * height` bytes, 0 or 1. */
export interface Bitmap {
  ink: Uint8Array;
  width: number;
  height: number;
}

/** Parse the shape rows the extractor writes (`#` is ink, anything else is not). */
export function shapeToBitmap(shape: string): Bitmap {
  // blank rows inside a glyph are geometry, only the trailing newline goes
  const rows = shape.split("\n");
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const height = rows.length;
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") ink[y * width + x] = 1;
    }
  }
  return { ink, width, height };
}

/** Render a bitmap back to shape rows, trailing blanks trimmed. */
export function bitmapToShape(bitmap: Bitmap): string {
  const rows: string[] = [];
  for (let y = 0; y < bitmap.height; y++) {
    let row = "";
    for (let x = 0; x < bitmap.width; x++) {
      row += bitmap.ink[y * bitmap.width + x] ? "#" : " ";
    }
    rows.push(row.replace(/ +$/, ""));
  }
  return rows.join("\n");
}

export interface Runs {
  start: Int32Array;
  length: Int32Array;
}

export interface BitmapRuns {
  along: Runs;
  perp: Runs;
}

const index = (
  axis: 0 | 1,
  line: number,
  offset: number,
  width: number,
): number => (axis === 0 ? line * width + offset : offset * width + line);

export function runLengths(bitmap: Bitmap, axis: 0 | 1): BitmapRuns {
  const { ink, width, height } = bitmap;
  const size = width * height;
  const alongStart = new Int32Array(size);
  const alongLength = new Int32Array(size);
  const perpStart = new Int32Array(size);
  const perpLength = new Int32Array(size);
  const lines = axis === 0 ? height : width;
  const along = axis === 0 ? width : height;
  for (let line = 0; line < lines; line++) {
    let offset = 0;
    while (offset < along) {
      if (!ink[index(axis, line, offset, width)]) {
        offset += 1;
        continue;
      }
      let end = offset;
      while (end < along && ink[index(axis, line, end, width)]) end += 1;
      for (let t = offset; t < end; t++) {
        const p = index(axis, line, t, width);
        alongStart[p] = offset;
        alongLength[p] = end - offset;
      }
      offset = end;
    }
  }
  // the perpendicular runs are the same computation in the other direction
  const other = axis === 0 ? 1 : 0;
  const otherLines = other === 0 ? height : width;
  const otherAlong = other === 0 ? width : height;
  for (let line = 0; line < otherLines; line++) {
    let offset = 0;
    while (offset < otherAlong) {
      if (!ink[index(other, line, offset, width)]) {
        offset += 1;
        continue;
      }
      let end = offset;
      while (end < otherAlong && ink[index(other, line, end, width)]) end += 1;
      for (let t = offset; t < end; t++) {
        const p = index(other, line, t, width);
        perpStart[p] = offset;
        perpLength[p] = end - offset;
      }
      offset = end;
    }
  }
  return {
    along: { start: alongStart, length: alongLength },
    perp: { start: perpStart, length: perpLength },
  };
}

interface CrossSection {
  line: number;
  start: number;
  length: number;
}

/**
 * Pixels reachable from the border without crossing ink, 4-connected. A
 * non-ink pixel that is *not* in here is enclosed by ink: a counter.
 */
export function outsideMask(bitmap: Bitmap): Uint8Array {
  const { ink, width, height } = bitmap;
  const outside = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (p: number) => {
    if (!ink[p] && !outside[p]) {
      outside[p] = 1;
      queue.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (queue.length) {
    const q = queue.pop()!;
    const x = q % width;
    const y = (q - x) / width;
    if (x > 0) push(q - 1);
    if (x < width - 1) push(q + 1);
    if (y > 0) push(q - width);
    if (y < height - 1) push(q + width);
  }
  return outside;
}

/** (components, holes) of the ink. */
export function topology(bitmap: Bitmap): [number, number] {
  const { ink, width, height } = bitmap;
  const seen = new Uint8Array(width * height);
  let components = 0;
  for (let p = 0; p < ink.length; p++) {
    if (!ink[p] || seen[p]) continue;
    components += 1;
    const stack = [p];
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % width;
      const y = (q - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const r = ny * width + nx;
          if (ink[r] && !seen[r]) {
            seen[r] = 1;
            stack.push(r);
          }
        }
      }
    }
  }
  // background: 4-connected from the border, whatever is left is a hole
  const outside = outsideMask(bitmap);
  let holes = 0;
  for (let p = 0; p < ink.length; p++) {
    if (ink[p] || outside[p]) continue;
    holes += 1;
    const stack = [p];
    outside[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % width;
      const y = (q - x) / width;
      if (x > 0 && !ink[q - 1] && !outside[q - 1]) {
        outside[q - 1] = 1;
        stack.push(q - 1);
      }
      if (x < width - 1 && !ink[q + 1] && !outside[q + 1]) {
        outside[q + 1] = 1;
        stack.push(q + 1);
      }
      if (y > 0 && !ink[q - width] && !outside[q - width]) {
        outside[q - width] = 1;
        stack.push(q - width);
      }
      if (y < height - 1 && !ink[q + width] && !outside[q + width]) {
        outside[q + width] = 1;
        stack.push(q + width);
      }
    }
  }
  return [components, holes];
}

/**
 * Take one layer off every straight 3-4px stem. Returns a new bitmap; the input
 * is left alone.
 */
export function capStems(
  source: Bitmap,
  options: StemCapOptions = {},
): { bitmap: Bitmap; removed: number } {
  const target = options.target ?? 2;
  const minLength = options.minLength ?? target + 1;
  const maxWidth = options.maxWidth ?? target + 3;
  const minPerp = options.minPerp ?? 4;
  const minStem = options.minStem ?? 2;
  const { width, height } = source;
  const { ink } = source;
  const runs = [runLengths(source, 0), runLengths(source, 1)];

  const lineCount = (axis: 0 | 1) => (axis === 0 ? height : width);
  const alongCount = (axis: 0 | 1) => (axis === 0 ? width : height);

  // Cross sections of straight stems, chained into stems. One line can hold
  // several stems side by side (朝 has three through every row), so the chains
  // are kept per span: a flat list would have the parallel stems interrupt one
  // another and only the last one per line would ever reach minStem - which
  // left 朝's left stem 2px at the top, 3px in the middle, 2px at the bottom.
  const groups: { axis: 0 | 1; sections: CrossSection[] }[] = [];
  for (const axis of [0, 1] as const) {
    const active = new Map<string, CrossSection[]>();
    const flush = (key: string) => {
      const chain = active.get(key)!;
      if (chain.length >= minStem) groups.push({ axis, sections: chain });
      active.delete(key);
    };
    for (let line = 0; line < lineCount(axis); line++) {
      let offset = 0;
      while (offset < alongCount(axis)) {
        const p = index(axis, line, offset, width);
        if (!ink[p]) {
          offset += 1;
          continue;
        }
        const start = runs[axis]!.along.start[p]!;
        const length = runs[axis]!.along.length[p]!;
        const perp = runs[axis]!.perp.length[p]!;
        if (length >= minLength && length <= maxWidth && perp >= minPerp) {
          const key = `${start}:${length}`;
          const chain = active.get(key);
          const last = chain?.[chain.length - 1];
          if (chain && last && last.line === line - 1) {
            chain.push({ line, start, length });
          } else {
            if (chain) flush(key);
            active.set(key, [{ line, start, length }]);
          }
        }
        offset = start + length;
      }
    }
    for (const key of [...active.keys()]) flush(key);
  }

  const blocked = new Uint8Array(width * height);
  const [baseComponents, baseHoles] = topology(source);

  for (const group of groups) {
    const { axis } = group;
    const sections = group.sections;
    const start = Math.min(...sections.map((s) => s.start));
    const length = Math.max(...sections.map((s) => s.length));
    const first = sections[0]!.line;
    const last = sections[sections.length - 1]!.line;
    // trailing edge of the cross section
    const edge = start + length - 1;
    const trial = new Uint8Array(width * height);
    let aborted = false;

    // A pixel may only go if the cross section through it ends here and neither
    // axis through it is thinner than a stem. "Ends here" is what keeps the
    // walk out of the body of a crossing stroke and off stroke ends; the two
    // length tests keep it off 1px and 2px strokes entirely.
    const free = (p: number): boolean => {
      if (!ink[p]) return false;
      const along = runs[axis]!.along;
      const perpendicular = runs[axis]!.perp;
      const alongStart = along.start[p]!;
      const alongLength = along.length[p]!;
      if (alongLength < minLength || perpendicular.length[p]! < minLength) {
        return false;
      }
      const offset = axis === 0 ? p % width : Math.floor(p / width);
      return offset === alongStart || offset === alongStart + alongLength - 1;
    };

    for (const sign of [-1, 1] as const) {
      let line = sign < 0 ? first - 1 : last + 1;
      while (line >= 0 && line < lineCount(axis)) {
        const p = index(axis, line, edge, width);
        if (!free(p)) {
          // The walk stops either at a junction (the pixel is interior to a
          // longer run: a crossing stroke takes over, and the layer ends
          // there - that is how 茶's 艹 stroke thins on both sides of a bar,
          // and 早's 日 column through its bars) or because the edge carries
          // on into a *thinner* section - its own run is short, or the stroke
          // it belongs to is. The second case has to abandon the group:
          // shaving part of an edge that carries on leaves a notch, which is
          // what turned 買's 罒 bar and 份's 亻 stroke ragged.
          if (
            ink[p] &&
            (runs[axis]!.along.length[p]! < minLength ||
              runs[axis]!.perp.length[p]! < minLength)
          ) {
            aborted = true;
          }
          break;
        }
        trial[p] = 1;
        line += sign;
      }
      if (aborted) break;
    }
    if (aborted) continue;
    for (let line = first; line <= last; line++) {
      const p = index(axis, line, edge, width);
      if (free(p)) trial[p] = 1;
    }
    if (!trial.some((v) => v)) continue;

    // keep it only if the glyph's structure survives
    const candidateInk = Uint8Array.from(ink, (v, p) =>
      v && !blocked[p] && !trial[p] ? 1 : 0,
    );
    const [components, holes] = topology({
      ink: candidateInk,
      width,
      height,
    });
    if (components !== baseComponents || holes !== baseHoles) continue;
    for (let p = 0; p < trial.length; p++) if (trial[p]) blocked[p] = 1;
  }

  const inkOut = Uint8Array.from(ink, (v, p) => (v && !blocked[p] ? 1 : 0));
  let removed = 0;
  for (let p = 0; p < blocked.length; p++) if (blocked[p]) removed += 1;
  return { bitmap: { ink: inkOut, width, height }, removed };
}

/** Convenience wrapper for the `#`/space shape strings the extractor writes. */
export function capShape(
  shape: string,
  options: StemCapOptions = {},
): { shape: string; removed: number } {
  const { bitmap, removed } = capStems(shapeToBitmap(shape), options);
  return { shape: bitmapToShape(bitmap), removed };
}

/** Cross section widths of stems, for reporting (in pixels). */
export function stemWidths(bitmap: Bitmap): number[] {
  const widths: number[] = [];
  const { ink, width, height } = bitmap;
  for (const axis of [0, 1] as const) {
    const runs = runLengths(bitmap, axis);
    const lines = axis === 0 ? height : width;
    const along = axis === 0 ? width : height;
    for (let line = 0; line < lines; line++) {
      let offset = 0;
      while (offset < along) {
        const p = index(axis, line, offset, width);
        if (!ink[p]) {
          offset += 1;
          continue;
        }
        const length = runs.along.length[p]!;
        if (length <= 5 && runs.perp.length[p]! >= 4) {
          widths.push(length);
        }
        offset += length;
      }
    }
  }
  return widths;
}

if (import.meta.main) {
  const { readdirSync, readFileSync, writeFileSync } = await import("fs");
  const path = await import("path");
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: bun run scripts/stem_cap.ts <shapes dir> [--write]");
    process.exit(1);
  }
  let glyphs = 0;
  let changed = 0;
  let removed = 0;
  const before: number[] = [];
  const after: number[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".txt"))) {
    const text = readFileSync(path.join(dir, file), "utf8");
    const newline = text.indexOf("\n");
    const header = newline < 0 ? "" : text.slice(0, newline);
    const shape = newline < 0 ? "" : text.slice(newline + 1).replace(/\n$/, "");
    if (!shape.trim()) continue;
    glyphs += 1;
    const source = shapeToBitmap(shape);
    before.push(...stemWidths(source));
    const { bitmap, removed: count } = capStems(source);
    after.push(...stemWidths(bitmap));
    if (count) {
      changed += 1;
      removed += count;
      if (write) {
        writeFileSync(
          path.join(dir, file),
          `${header}\n${bitmapToShape(bitmap)}\n`,
        );
      }
    }
  }
  const hist = (values: number[]) => {
    const counts = new Map<number, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const total = values.length || 1;
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k}px:${Math.round((v / total) * 100)}%`)
      .join(" ");
  };
  console.log(
    `${dir}: ${glyphs} glyphs, ${changed} changed, ${removed} px removed${write ? " (written)" : " (dry run)"}`,
  );
  console.log(`  stems before: ${hist(before)}`);
  console.log(`  stems after : ${hist(after)}`);
}
