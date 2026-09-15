import { FontExtractor } from "./extractor";
import { capShape } from "./stem_cap";
import { widenShape } from "./stem_widen";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";

const { values, positionals } = parseArgs({
  args: process.argv,
  strict: false,
  allowPositionals: true,
  options: {
    force: {
      type: "boolean",
      short: "f",
    },
  },
});

const __dirname = new URL(".", import.meta.url).pathname;

// read extract definition
const definition = positionals[2]
  ? JSON.parse(fs.readFileSync(positionals[2], "utf-8"))
  : {};

const pageFile = definition.pageFile ?? "./build/pages.txt";
const topOffset = definition.topOffset ?? 7;
const leftOffset = definition.leftOffset ?? 0;
const advanceOffset = definition.advanceOffset ?? 0;
const fontName = definition.fontName ?? "unifont";
const fontSize = definition.fontSize ?? 24;
const sourceFont =
  definition.fontFile ??
  path.resolve(__dirname, "../data/fonts/unifont/unifont-17.0.03.otf");
// Variable fonts: `variation` pins the axes (e.g. { "wght": 400 }) and the
// extractor runs on a static instance. Instancing a CJK font takes a while
// (fontTools rewrites every glyph), so the instance is cached next to the
// source and reused; delete it to force a rebuild.
const variation: Record<string, number> | null = definition.variation ?? null;

const instanceFont = (file: string, axes: Record<string, number>) => {
  const key = Object.entries(axes)
    .map(([axis, value]) => `${axis}${value}`)
    .join("-");
  const target = `${file.replace(/\.(otf|ttf|ttc)$/i, "")}.${key}.otf`;
  if (
    fs.existsSync(target) &&
    fs.statSync(target).mtimeMs > fs.statSync(file).mtimeMs
  ) {
    return target;
  }
  const args = [
    "-m",
    "fontTools.varLib.instancer",
    "-q",
    "-o",
    target,
    file,
    ...Object.entries(axes).map(([axis, value]) => `${axis}=${value}`),
  ];
  const result = Bun.spawnSync(["python3", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0 || !fs.existsSync(target)) {
    throw new Error(
      `instancing ${path.basename(file)} at ${key} failed - is fontTools installed ` +
        `(pip install fonttools)?\n${result.stderr.toString()}`,
    );
  }
  return target;
};

const fontFile = variation ? instanceFont(sourceFont, variation) : sourceFont;
const renderWidth = definition.renderWidth ?? 16;
const renderHeight = definition.renderHeight ?? 16;
const wildcardHeight = definition.wildcardHeight ?? 16;
const wildcardWidth = definition.wildcardWidth ?? 7;
const forceAutohint = definition.forceAutohint ?? false;
const ranges: [number, number][] = definition.ranges ?? [[-Infinity, Infinity]];
const autoJiggle: false | [number, number] = definition.autoJiggle ?? false;
// take one layer off 3px+ stems, and add one to 1px stems, so a glyph has one
// stroke width instead of a mix of 1px, 2px and 3px
const capStems = definition.capStems ?? false;
const widenStems = definition.widenStems ?? false;
const outputDir = definition.outputDir ?? `./fonts/${fontName}`;

// the custom stroke rasterizer is gone; stemCap/stemWiden cover its job
for (const gone of ["strokeWidth", "thinWidth", "supersample"]) {
  if (definition[gone] !== undefined && definition[gone] !== 0) {
    console.warn(
      `WARNING: "${gone}" is no longer supported and will be ignored ` +
        `(use capStems/widenStems instead)`,
    );
  }
}

/**
 * Run the stem cap pass over an extracted glyph and re-anchor it: the pass only
 * removes ink, so when it empties the leading row or column of the bitmap the
 * glyph has to move by that much to stay where it was.
 */
const capGlyph = (glyph: {
  shape: string;
  top: number;
  left: number;
  advance: number;
}) => {
  const rows = capShape(glyph.shape).shape.split("\n");
  let first = 0;
  while (first < rows.length && !rows[first]!.includes("#")) first++;
  if (first >= rows.length) {
    return glyph;
  }
  let last = rows.length - 1;
  while (last > first && !rows[last]!.includes("#")) last--;
  let minX = Infinity;
  let maxX = -1;
  for (let y = first; y <= last; y++) {
    const row = rows[y]!;
    const at = row.indexOf("#");
    if (at < 0) continue;
    minX = Math.min(minX, at);
    maxX = Math.max(maxX, row.lastIndexOf("#"));
  }
  return {
    ...glyph,
    shape: rows
      .slice(first, last + 1)
      .map((row) => row.slice(minX, maxX + 1))
      .join("\n"),
    top: glyph.top + first,
    left: glyph.left + minX,
  };
};

const segmentor = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cjk = Array.from(
  segmentor.segment(fs.readFileSync(pageFile, "utf8")),
).map((s) => s.segment);
const extractor = new FontExtractor(fontFile);

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(`${outputDir}/glyphs`, { recursive: true });
fs.mkdirSync(`${outputDir}/shapes`, { recursive: true });

let written = 0;

for (const char of cjk) {
  const codepoint = char.codePointAt(0)!;
  if (!codepoint) continue;
  if (!ranges.some(([start, end]) => codepoint >= start && codepoint <= end)) {
    continue;
  }

  let glyph:
    | false
    | {
        shape: string;
        top: number;
        left: number;
        advance: number;
      } = false;

  if (typeof autoJiggle === "object") {
    glyph = extractor.autoJiggle(
      codepoint,
      autoJiggle[0],
      autoJiggle[1],
      renderWidth,
      renderHeight,
      forceAutohint,
    );
  } else {
    glyph = extractor.convert(
      codepoint,
      renderWidth,
      renderHeight,
      forceAutohint,
    );
  }

  if (glyph) {
    if (capStems) {
      glyph = capGlyph(glyph);
    }
    if (widenStems) {
      glyph = { ...glyph, shape: widenShape(glyph.shape).shape };
    }
    const top = glyph.shape ? topOffset + glyph.top : 0;
    const left = glyph.shape ? leftOffset + glyph.left : 0;

    if (top < 0 || left < 0) {
      console.log(`WARNING: OOB ${char} ${codepoint} ${top} ${left}`);
    }

    if (
      !values.force &&
      fs.existsSync(`${outputDir}/glyphs/${codepoint}.txt`)
    ) {
      continue;
    }

    fs.writeFileSync(
      `${outputDir}/shapes/${codepoint}.txt`,
      `${top} ${left}\n${glyph.shape}`,
    );

    fs.writeFileSync(
      `${outputDir}/glyphs/${codepoint}.txt`,
      `${Math.round(glyph.advance + advanceOffset)}\n0 0 ${codepoint}`,
    );
    written++;
  }
}

if (!fs.existsSync(`${outputDir}/font.json`)) {
  fs.writeFileSync(
    `${outputDir}/font.json`,
    JSON.stringify({
      name: fontName,
      height: fontSize,
      wildcardCodepoint: 9647,
    }),
  );
}

const generateWildcard = (width: number, height: number) => {
  // draw a box
  const lines = ["#".repeat(width)];
  for (let i = 0; i < height - 2; i++) {
    lines.push("#" + " ".repeat(width - 2) + "#");
  }
  lines.push("#".repeat(width));
  return lines.join("\n");
};

if (!fs.existsSync(`${outputDir}/glyphs/9647.txt`)) {
  // Writes the wildcard glyph to make the font buildable
  fs.writeFileSync(
    `${outputDir}/glyphs/9647.txt`,
    `${wildcardWidth + 2}\n0 0 WILDCARD`,
  );
  fs.writeFileSync(
    `${outputDir}/shapes/WILDCARD.txt`,
    `${fontSize - wildcardHeight + 1} 1\n` +
      generateWildcard(wildcardWidth, wildcardHeight),
  );
  written++;
}

console.log(
  `Extracted and wrote ${written} glyphs to ${outputDir}` +
    (variation
      ? ` from ${path.basename(sourceFont)} at ${JSON.stringify(variation)}`
      : "") +
    (capStems ? ", stems capped to 2px" : "") +
    (widenStems ? ", thin stems widened to 2px" : ""),
);
