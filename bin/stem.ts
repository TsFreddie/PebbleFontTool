/**
 * Run the stem passes over an existing shapes directory instead of extracting
 * from a font.
 *
 * A pack's shapes carry hand edits (a stroke widened here, a bar thickened
 * there), and re-extracting from the source font throws those away. This runs
 * `capStems` + `widenStems` on the shapes as they are, so a pack keeps its
 * glyphs and only has its stroke widths evened out.
 *
 * Usage:
 *   bun run bin/stem.ts <shapes dir or font dir> --out <dir> [--cap 2] [--widen 2]
 *   bun run bin/stem.ts fonts/TUMBLED_28 --out /tmp/out --cap 2 --widen 0
 */
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { capShape, shapeToBitmap } from "../scripts/stem_cap";
import { widenShape } from "../scripts/stem_widen";

const { values, positionals } = parseArgs({
  args: process.argv,
  strict: false,
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    cap: { type: "string" },
    widen: { type: "string" },
  },
});

const input = positionals[2];
if (!input) {
  console.error(
    "usage: bun run bin/stem.ts <shapes dir or font dir> --out <dir> [--cap 2] [--widen 2]",
  );
  process.exit(1);
}

const shapeDir = fs.existsSync(path.join(input, "shapes"))
  ? path.join(input, "shapes")
  : input;
if (!fs.existsSync(shapeDir)) {
  console.error(`No shapes in ${input}`);
  process.exit(1);
}

const outDir = path.resolve(
  (values.out as string | undefined) ?? `${input}-stemmed`,
);
const capTarget = Number(values.cap ?? 2);
const widenTarget = Number(values.widen ?? 2);
fs.mkdirSync(outDir, { recursive: true });

let glyphs = 0;
let changed = 0;
let removed = 0;
let added = 0;

for (const file of fs.readdirSync(shapeDir)) {
  if (!file.endsWith(".txt")) continue;
  const text = fs.readFileSync(path.join(shapeDir, file), "utf8");
  const nl = text.indexOf("\n");
  if (nl < 0) continue;
  const header = text.slice(0, nl);
  const shape = text.slice(nl + 1).replace(/\n$/, "");
  if (!shape.trim()) {
    fs.writeFileSync(path.join(outDir, file), text);
    continue;
  }

  glyphs += 1;
  const source = shapeToBitmap(shape);
  let result = shape;
  if (capTarget > 0) result = capShape(result, { target: capTarget }).shape;
  if (widenTarget > 0)
    result = widenShape(result, { target: widenTarget }).shape;
  const out = shapeToBitmap(result);
  for (let i = 0; i < source.ink.length; i++) {
    if (source.ink[i] && !out.ink[i]) removed += 1;
    if (!source.ink[i] && out.ink[i]) added += 1;
  }
  if (!source.ink.every((v, i) => v === out.ink[i]!)) changed += 1;
  // the passes never remove ink outside the original bbox, so the header and
  // the grid stay as they are
  fs.writeFileSync(path.join(outDir, file), `${header}\n${result}\n`);
}

console.log(
  `${glyphs} glyphs -> ${outDir}: ${changed} changed, +${added} -${removed} px` +
    (fs.existsSync(path.join(input, "glyphs"))
      ? " (the glyphs/ dir is unchanged, copy it alongside if you build from there)"
      : ""),
);
