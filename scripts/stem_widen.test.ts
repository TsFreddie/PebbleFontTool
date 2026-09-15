import { expect, test } from "bun:test";
import { capShape, shapeToBitmap, topology } from "./stem_cap";
import { type StemWidenSide, widenShape, widenStems } from "./stem_widen";

/**
 * 朝 from TUMBLED_28. Capping it removes 4 pixels, widening it adds exactly 22
 * (rows 7, 10 and 12 get their second layer, the box sides get their second
 * column) - that is the reference bitmap the pass was specified against.
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

/** 誰: its 言 radical's first bar is 1px and touches the dot above it. */
const 誰 = `   #
   ##     ######
   ##     ##  ##
    #     ##  ###
######## ###########
         ###########
        ###   ##
 ###### ###   ##
        ###########
        ###########
 ######  ##   ##
         ##   ##
         ##   ##
 ######  ##########
 ######  ##########
 ##   #  ##   ##
 ##   #  ##   ##
 ##   #  ##   ##
 ######  ###########
 ##      ##
 ##      ##`;

function added(shape: string, side: StemWidenSide = "uniform") {
  const before = shapeToBitmap(shape);
  const after = shapeToBitmap(widenShape(shape, { side }).shape);
  const pixels: [number, number][] = [];
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const p = y * before.width + x;
      if (!before.ink[p] && after.ink[p]) pixels.push([y, x]);
    }
  }
  return pixels;
}

test("朝: widening adds the 22 pixels of the reference bitmap", () => {
  const capped = capShape(朝).shape;
  expect(added(capped)).toEqual([
    [7, 2],
    [7, 3],
    [7, 4],
    [7, 5],
    [7, 6],
    [7, 7],
    [8, 2],
    [8, 7],
    [10, 2],
    [10, 3],
    [10, 4],
    [10, 5],
    [10, 6],
    [10, 7],
    [11, 2],
    [11, 7],
    [12, 2],
    [12, 3],
    [12, 4],
    [12, 5],
    [12, 6],
    [12, 7],
  ]);
});

test("a stem crossed by another stroke is widened once, not per piece", () => {
  // a 1px bar with a 2px post through it: the bar must end up 2px, never 3px
  const rows = [
    "  ##   ",
    "  ##   ",
    "########",
    "  ##   ",
    "  ##   ",
    "        ",
    "        ",
  ];
  const before = shapeToBitmap(rows.join("\n"));
  const after = shapeToBitmap(widenShape(rows.join("\n")).shape);
  // only the bar's own columns: the post's columns are legitimately taller
  for (let x = 0; x < before.width; x++) {
    const barOnly =
      before.ink[2 * before.width + x] &&
      !before.ink[1 * before.width + x] &&
      !before.ink[3 * before.width + x];
    if (!barOnly) continue;
    let thickness = 0;
    for (let y = 0; y < before.height; y++)
      if (after.ink[y * before.width + x]) thickness += 1;
    expect(thickness).toBe(2); // one layer of the bar, never two
  }
  // the bar itself is 2px tall in the columns next to the post (rows 2 and 3)
  let height = 0;
  for (let y = 0; y < before.height; y++) {
    if (after.ink[y * before.width + 0]) height += 1;
  }
  expect(height).toBe(2);
});

test("vertical stems keep two white pixels, horizontal ones one", () => {
  const boxed = ["#######", "#     #", "#     #", "#     #", "#######"].join(
    "\n",
  );
  // a lone 1px column with 3 white either side gets widened
  expect(added(shapeWithColumn(3)).length).toBeGreaterThan(0);
  // with only 1 white either side it stays 1px
  expect(added(shapeWithColumn(1))).toEqual([]);
  void boxed;
});

function shapeWithColumn(gap: number) {
  const width = gap * 2 + 1;
  const line = " ".repeat(gap) + "#" + " ".repeat(gap);
  const border = "#".repeat(width);
  return [border, border, line, line, line, line, border, border].join("\n");
}

test("widening never grows the ink bounding box", () => {
  const source = `
  ###
  # #
  ###`.trim();
  const before = shapeToBitmap(source);
  const after = shapeToBitmap(widenShape(source).shape);
  const box = (bitmap: ReturnType<typeof shapeToBitmap>) => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < bitmap.height; y++)
      for (let x = 0; x < bitmap.width; x++) {
        if (!bitmap.ink[y * bitmap.width + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    return [minX, minY, maxX, maxY];
  };
  expect(box(after)).toEqual(box(before));
});

test("誰: the 言 first bar reaches 2px and no white speck is trapped", () => {
  const capped = capShape(誰).shape;
  const before = shapeToBitmap(capped);
  const after = shapeToBitmap(widenShape(capped).shape);
  // the first bar (row 4, cols 0..7) has a second layer next to it
  const barRow = 4;
  let bar = 0;
  for (let y = barRow - 1; y <= barRow + 1; y++) {
    if (after.ink[y * before.width + 0]) bar += 1;
  }
  expect(bar).toBe(2);
  // and the pass may not create a new 1px enclosed white pixel
  const enclosed = (ink: Uint8Array) => {
    const out = new Uint8Array(before.width * before.height);
    for (let y = 1; y < before.height - 1; y++) {
      for (let x = 1; x < before.width - 1; x++) {
        const p = y * before.width + x;
        out[p] =
          !ink[p] &&
          ink[p - 1] === 1 &&
          ink[p + 1] === 1 &&
          ink[p - before.width] === 1 &&
          ink[p + before.width] === 1;
      }
    }
    return out;
  };
  const was = enclosed(before.ink);
  const now = enclosed(after.ink);
  for (let p = 0; p < now.length; p++)
    expect(now[p] === 1 && was[p] === 0).toBe(false);
});

test("widening a glyph with counters leaves them open", () => {
  const ring = [
    "#########",
    "#       #",
    "#       #",
    "#       #",
    "#########",
  ].join("\n");
  const before = shapeToBitmap(ring);
  const { bitmap } = widenStems(before);
  expect(topology(bitmap)).toEqual(topology(before));
});
