// Render a specimen sheet of the fonts in a PebbleOS resource tree (or of
// explicit PBF files) into a single PNG.
//
// Usage:
//   fontsheet.ts --pebble /path/to/PebbleOS -o images/gothic.png
//   fontsheet.ts --pebble /path/to/PebbleOS --all -o images/all_fonts.png
//   fontsheet.ts build/GOTHIC_14.pbf build/TUMBLED_18.pbf -o sheet.png
import { parseArgs } from "util";
import fs from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { readPbf } from "../lib/pbf_reader";

type Pbf = ReturnType<typeof readPbf>;
type Ctx = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

interface LoadedFont {
  name: string;
  file: string;
  font: Pbf;
}

const { positionals, values } = parseArgs({
  args: process.argv,
  strict: false,
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    pebble: { type: "string" },
    scale: { type: "string", short: "s" },
    "max-width": { type: "string", short: "w" },
    all: { type: "boolean" },
    text: { type: "string", short: "t" },
    coverage: { type: "boolean" },
  },
});

const outFile =
  typeof values.out === "string" ? values.out : "./images/fontsheet.png";
const scale =
  typeof values.scale === "string"
    ? Math.max(1, parseInt(values.scale, 10))
    : 1;
const maxWidth =
  typeof values["max-width"] === "string"
    ? parseInt(values["max-width"], 10)
    : 1100;

// Default sample text. The pangram contains every letter; use --text to render
// something else (a literal \n starts a new line).
const DEFAULT_TEXT = "The quick brown fox jumps over the lazy dog.";

const discoverPebbleFonts = (pebblePath: string, all: boolean) => {
  const resources = fs.existsSync(path.join(pebblePath, "resources"))
    ? path.join(pebblePath, "resources")
    : pebblePath;
  const maps = [
    "common/base/resource_map.json",
    "normal/base/resource_map.json",
  ]
    .map((rel) => path.join(resources, rel))
    .filter((file) => fs.existsSync(file));
  if (maps.length === 0) {
    throw new Error(
      `${pebblePath} does not look like a PebbleOS resource tree`,
    );
  }

  // Later maps override earlier ones, mirroring the firmware resource build.
  const byName = new Map<string, string>();
  for (const mapPath of maps) {
    const resourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    for (const item of resourceMap.media ?? []) {
      if (item.type === "font" && item.file) {
        byName.set(item.name, item.file);
      }
    }
  }

  // Fonts built from .ttf/.bdf/.otf sources at firmware build time have no
  // PBF on disk; only prebuilt .pbf files can be rendered directly.
  return [...byName.entries()]
    .filter(
      ([name, file]) =>
        (all || /^GOTHIC_\d+(_BOLD)?$/.test(name)) && file.endsWith(".pbf"),
    )
    .map(([name, file]) => ({ name, file: path.join(resources, file) }));
};

const sortFonts = (a: LoadedFont, b: LoadedFont) => {
  const key = (name: string) => {
    const match = /^([A-Z_]+?)_?(\d+)(_BOLD)?$/.exec(name);
    return [
      match?.[1] ?? name,
      parseInt(match?.[2] ?? "0", 10),
      match?.[3] ? 1 : 0,
    ];
  };
  const ka = key(a.name);
  const kb = key(b.name);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
  }
  return 0;
};

const readGlyph = (font: Pbf, codepoint: number) => {
  try {
    return font.read(codepoint);
  } catch {
    try {
      return font.read(font.wildcardCodepoint);
    } catch {
      return null;
    }
  }
};

// Wrap text at whole-codepoint boundaries so it fits into `width` pixels.
const wrapText = (font: Pbf, text: string, width: number) => {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let pendingSpace = "";
  for (const char of text) {
    const glyph = readGlyph(font, char.codePointAt(0)!);
    const advance = glyph?.advance ?? 0;
    if (char === " ") {
      pendingSpace += char;
      currentWidth += advance;
      if (currentWidth > width && current.trim() !== "") {
        lines.push(current.trimEnd());
        current = "";
        currentWidth = 0;
        pendingSpace = "";
      }
      continue;
    }
    if (currentWidth + advance > width && current !== "") {
      lines.push(current.trimEnd());
      current = "";
      currentWidth = 0;
      pendingSpace = "";
    }
    current += pendingSpace + char;
    currentWidth += advance;
    pendingSpace = "";
  }
  if (current !== "") lines.push(current.trimEnd());
  return lines;
};

const measureText = (font: Pbf, text: string) => {
  let width = 0;
  for (const char of text) {
    width += readGlyph(font, char.codePointAt(0)!)?.advance ?? 0;
  }
  return width;
};

const drawText = (
  ctx: Ctx,
  font: Pbf,
  text: string,
  x: number,
  baselineY: number,
) => {
  let cursor = x;
  for (const char of text) {
    const glyph = readGlyph(font, char.codePointAt(0)!);
    if (!glyph) continue;
    const lines = glyph.data.split("\n");
    const gx = cursor + glyph.left;
    // PBF stores the glyph top as an offset from the line top (baseline
    // minus the FreeType bitmap_top), so add it to the line's baseline.
    const gy = baselineY - font.maxHeight + glyph.top;
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row]!;
      for (let col = 0; col < line.length; col++) {
        if (line[col] === "#") {
          ctx.fillRect(gx + col, gy + row, 1, 1);
        }
      }
    }
    cursor += glyph.advance;
  }
  return cursor - x;
};

const drawLine = (
  ctx: Ctx,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
) => {
  ctx.fillStyle = color;
  if (y1 === y2) ctx.fillRect(Math.min(x1, x2), y1, Math.abs(x2 - x1), 1);
  else if (x1 === x2) ctx.fillRect(x1, Math.min(y1, y2), 1, Math.abs(y2 - y1));
};

const main = () => {
  const sources = values.pebble
    ? discoverPebbleFonts(path.resolve(values.pebble as string), !!values.all)
    : positionals.slice(2).map((file) => ({
        name: path.basename(file, ".pbf"),
        file: path.resolve(file),
      }));

  if (sources.length === 0) {
    console.error(
      "No fonts found. Use --pebble <PebbleOS path> or pass .pbf files.",
    );
    process.exit(1);
  }

  const loaded: LoadedFont[] = sources.map(({ name, file }) => ({
    name,
    file,
    font: readPbf(fs.readFileSync(file)),
  }));
  loaded.sort(sortFonts);

  const sampleLines = (
    typeof values.text === "string" ? values.text : DEFAULT_TEXT
  ).split("\n");

  const sheets = loaded.map((loadedFont) => {
    const { font } = loadedFont;
    const covered = new Set<number>();
    for (const line of sampleLines) {
      for (const char of line) covered.add(char.codePointAt(0)!);
    }
    const missing = Object.keys(font.offsetTables)
      .map(Number)
      .filter(
        (cp) =>
          !covered.has(cp) &&
          cp > 0x20 &&
          cp !== font.wildcardCodepoint &&
          !/\s/.test(String.fromCodePoint(cp)),
      )
      .sort((a, b) => a - b);
    const lines = [...sampleLines];
    if (missing.length > 0 && values.coverage) {
      lines.push(
        "extra: " + missing.map((cp) => String.fromCodePoint(cp)).join(" "),
      );
    }
    return { ...loadedFont, lines, missing };
  });

  // Choose a UI font for the labels: prefer stock GOTHIC_14, else the smallest.
  const labelSource =
    loaded.find((entry) => entry.name === "GOTHIC_14") ??
    [...loaded].sort((a, b) => a.font.maxHeight - b.font.maxHeight)[0]!;
  const labelFont = labelSource.font;

  const margin = 12;
  const padTop = 10;
  const padBottom = 14;
  const labelGap = 6;
  const lineGap = 6;
  const titleGap = 10;

  const title = values.pebble ? "PebbleOS firmware fonts" : "Font specimen";

  const labels = sheets.map(
    ({ name, font }) =>
      `${name}  ·  ${font.maxHeight}px  ·  ${font.numberOfGlyphs} glyphs  ·  ` +
      `${font.features.compressed ? "RLE4" : "plain"}  ·  ${font.features.offsetByteWidth * 8}-bit offsets`,
  );
  const widestSample = Math.max(
    ...sheets.flatMap((sheet) =>
      sheet.lines.map((line) => measureText(sheet.font, line)),
    ),
  );
  const contentWidth = Math.max(
    Math.min(widestSample, maxWidth),
    ...labels.map((label) => measureText(labelFont, label)),
  );
  const wrappedLines = sheets.map((sheet) =>
    sheet.lines.flatMap((line) => wrapText(sheet.font, line, contentWidth)),
  );

  const titleHeight = labelFont.maxHeight * 2 + titleGap + 4;
  const rows = sheets.map((sheet, index) => {
    const { font } = sheet;
    const lineHeight = font.maxHeight + lineGap;
    const labelHeight = labelFont.maxHeight;
    const rowHeight =
      padTop +
      labelHeight +
      labelGap +
      wrappedLines[index]!.length * lineHeight +
      padBottom;
    return {
      sheet,
      lines: wrappedLines[index]!,
      label: labels[index]!,
      lineHeight,
      rowHeight,
    };
  });

  let cursorY = margin + titleHeight;
  const layout = rows.map((row) => {
    const rowTop = cursorY;
    cursorY += row.rowHeight;
    return { ...row, rowTop };
  });
  const sheetWidth = contentWidth + margin * 2;
  const sheetHeight = cursorY + margin;

  const canvas = createCanvas(sheetWidth * scale, sheetHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);

  ctx.fillStyle = "#111111";
  drawText(ctx, labelFont, title, margin, margin + labelFont.maxHeight);
  ctx.fillStyle = "#666666";
  drawText(
    ctx,
    labelFont,
    `${layout.length} font${layout.length === 1 ? "" : "s"} · ` +
      `${values.pebble ? path.resolve(values.pebble as string) : "user supplied"}`,
    margin,
    margin + labelFont.maxHeight * 2 + titleGap,
  );

  for (const row of layout) {
    const { font } = row.sheet;
    const bottom = row.rowTop + row.rowHeight;

    drawLine(
      ctx,
      margin,
      row.rowTop,
      sheetWidth - margin,
      row.rowTop,
      "#d0d0d0",
    );

    ctx.fillStyle = "#333333";
    drawText(
      ctx,
      labelFont,
      row.label,
      margin,
      row.rowTop + padTop + labelFont.maxHeight,
    );

    const lineTop = row.rowTop + padTop + labelFont.maxHeight + labelGap;
    for (let i = 0; i < row.lines.length; i++) {
      const baselineY = lineTop + i * row.lineHeight + font.maxHeight;
      drawLine(
        ctx,
        margin,
        baselineY,
        sheetWidth - margin,
        baselineY,
        "#f0f0f0",
      );
      ctx.fillStyle = "#000000";
      drawText(ctx, font, row.lines[i]!, margin, baselineY);
    }

    drawLine(ctx, margin, bottom, sheetWidth - margin, bottom, "#e8e8e8");
  }

  ctx.restore();

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, canvas.toBuffer("image/png"));

  for (const row of layout) {
    const { font } = row.sheet;
    console.log(
      `${row.sheet.name.padEnd(18)} h=${String(font.maxHeight).padStart(2)} ` +
        `glyphs=${String(font.numberOfGlyphs).padStart(4)} ` +
        `extra=${row.sheet.missing.length} lines=${row.lines.length}`,
    );
  }
  console.log(
    `Wrote ${layout.length} fonts to ${outFile} (${canvas.width}x${canvas.height})`,
  );
};

main();
