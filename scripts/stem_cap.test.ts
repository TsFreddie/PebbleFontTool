import { expect, test } from "bun:test";
import { capShape, capStems, shapeToBitmap, topology } from "./stem_cap";

/**
 * The reference case: TUMBLED_28's own bitmaps, where the autohinter lands the
 * same stroke at 2px and 3px. These expectations come from the bitmap the cap
 * pass was specified against (14 removed pixels: 4 in 朝, 10 in 早).
 */
const 朝 = `    ##
    ##     ########
    ##     ########
########## ########
########## ##    ##
    ##     ##    ##
 ########  ########
 #      #  ########
 #      #  ##    ##
 ########  ##    ##
 #      #  ##    ##
 #      #  ##    ##
 #      #  ########
 ########  ########
    ##     ##    ##
############     ##
############     ##
    ##    ##     ##
    ##   ##      ##
    ##  ###   #####
    ##   #     ###`;

const 早 = `  ################
  ################
  ##           ###
  ##           ###
  ################
  ################
  ##           ###
  ##           ###
  ################
  ################
         ##
         ##
         ##
####################
####################
         ##
         ##
         ##
         ##
         ##`;

const 我 = `      ###  ##
   ######  ##  ###
 ######    ##   ###
 ##  ##    ##    ##
     ##    ##     #
     ##    ##
####################
####################
     ##     ##
     ##     ##   ##
     ##     ##  ###
     ###### ## ###
##########  #####
#######      ###
     ##     ###
     ##    #####   #
     ##   ### ##  ##
     ## ####  ### ##
 ###### ##     #####
  ####          ###`;

function removedPixels(shape: string) {
  const source = shapeToBitmap(shape);
  const { bitmap } = capStems(source);
  const out: [number, number][] = [];
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const p = y * source.width + x;
      if (source.ink[p] && !bitmap.ink[p]) out.push([y, x]);
    }
  }
  return out;
}

test("caps the third row of 朝's 月 top bar", () => {
  expect(removedPixels(朝)).toEqual([
    [3, 13],
    [3, 14],
    [3, 15],
    [3, 16],
  ]);
});

test("caps the outer column of 早's 日 box, through the bars", () => {
  expect(removedPixels(早)).toEqual([
    [0, 17],
    [1, 17],
    [2, 17],
    [3, 17],
    [4, 17],
    [5, 17],
    [6, 17],
    [7, 17],
    [8, 17],
    [9, 17],
  ]);
});

test("leaves 我 alone: its strokes are 1px and 2px", () => {
  expect(removedPixels(我)).toEqual([]);
});

test("2px and 1px strokes survive untouched", () => {
  const bar = (width: number, height: number, thickness: number) => {
    const rows: string[] = [];
    for (let y = 0; y < height; y++) {
      rows.push("#".repeat(y >= 2 && y < 2 + thickness ? width : 0));
    }
    return rows.join("\n");
  };
  expect(removedPixels(bar(10, 8, 1))).toEqual([]);
  expect(removedPixels(bar(10, 8, 2))).toEqual([]);
  const { shape } = capShape(bar(10, 8, 3));
  expect(shape.split("\n").filter((r) => r.includes("#")).length).toBe(2);
});

test("a 3px stem loses one edge for its whole length", () => {
  const rows = Array.from({ length: 8 }, () => "   ###   ");
  expect(removedPixels(rows.join("\n")).length).toBe(8);
});

test("a 3x3 blob and a diagonal staircase are not stems", () => {
  expect(
    removedPixels(`###
###
###`),
  ).toEqual([]);
  const diagonal = Array.from(
    { length: 8 },
    (_, i) => `${" ".repeat(i)}##`,
  ).join("\n");
  expect(removedPixels(diagonal)).toEqual([]);
});

test("capping never changes components or holes", () => {
  // 3px-thick ring: the pass may shave it, but the counter must survive
  const ring: string[] = [];
  for (let y = 0; y < 13; y++) {
    let row = "";
    for (let x = 0; x < 13; x++) {
      const border = x < 3 || x > 9 || y < 3 || y > 9;
      row += border ? "#" : " ";
    }
    ring.push(row);
  }
  const shape = ring.join("\n");
  const source = shapeToBitmap(shape);
  const { bitmap } = capStems(source);
  expect(topology(bitmap)).toEqual(topology(source));
  expect(topology(bitmap)).toEqual([1, 1]);
});

test("every removal is on a stroke at least 3px thick", () => {
  const shapes = [朝, 早, 我];
  for (const shape of shapes) {
    const source = shapeToBitmap(shape);
    const { bitmap } = capStems(source);
    const { width } = source;
    const run = (p: number, dx: number, dy: number) => {
      const x = p % width;
      const y = (p - x) / width;
      let length = 1;
      for (const sign of [-1, 1]) {
        let cx = x + dx * sign;
        let cy = y + dy * sign;
        while (cx >= 0 && cy >= 0 && cx < width && cy < source.height) {
          const q = cy * width + cx;
          if (!source.ink[q]) break;
          length += 1;
          cx += dx * sign;
          cy += dy * sign;
        }
      }
      return length;
    };
    for (let p = 0; p < source.ink.length; p++) {
      if (!source.ink[p] || bitmap.ink[p]) continue;
      expect(Math.min(run(p, 1, 0), run(p, 0, 1))).toBeGreaterThanOrEqual(3);
    }
  }
});

test("a stem whose edge carries on thinner keeps its layer", () => {
  // 4px wide for four rows, 2px under it (right edge aligned): shaving the
  // thick part alone leaves a jog, the way 份's 亻 stroke came out
  const shape = [
    " ###",
    " ###",
    " ###",
    "####",
    "####",
    "####",
    "####",
    "  ##",
    "  ##",
    "  ##",
  ].join("\n");
  const { removed } = capShape(shape);
  expect(removed).toBe(0);
});

test("a bar crossed by a stem is thinned on both sides of the crossing", () => {
  // the layer comes off wherever the edge is free: the stem thins above and
  // below the bar, the bar thins outside the stem - but never the crossing
  // itself (茶's 艹 stroke over its bar, 早's 日 column through its bars)
  const shape = [
    "  ###  ",
    "  ###  ",
    "#######",
    "#######",
    "#######",
    "  ###  ",
    "  ###  ",
  ].join("\n");
  const { shape: capped, removed } = capShape(shape);
  expect(removed).toBe(8);
  const rows = capped.split("\n");
  // the stem above and below the bar loses its right column
  expect(rows[0]).toBe("  ##");
  expect(rows[1]).toBe("  ##");
  expect(rows[5]).toBe("  ##");
  expect(rows[6]).toBe("  ##");
  // the bar loses its bottom row outside the stem, so it is 2px there
  expect(rows[4]).toBe("  ###");
  // and the crossing keeps every pixel
  expect(rows[2]).toBe("#######");
  expect(rows[3]).toBe("#######");
});

test("parallel stems do not break each other's chains", () => {
  // 朝 has three stems through every row. Chained off a flat cross-section
  // list they interrupted one another and only the last per line survived,
  // which left the same stem 2px at the top and 3px further down.
  const shape = ["###  ###", "###  ###", "###  ###", "###  ###"].join("\n");
  const { shape: capped, removed } = capShape(shape);
  expect(removed).toBe(8);
  // each stem loses its right column, so a gap grows to three spaces
  for (const row of capped.split("\n")) expect(row).toBe("##   ##");
});

test("a clean 3px stem still loses a layer", () => {
  const shape = ["###", "###", "###", "###", "###"].join("\n");
  const { removed } = capShape(shape);
  expect(removed).toBe(5);
});
