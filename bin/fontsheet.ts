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
    title: { type: "string" },
    coverage: { type: "boolean" },
    fallback: { type: "string", short: "f" },
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

// Look a glyph up in the row's font chain; the last font of the chain draws
// the wildcard for codepoints nothing covers.
const readGlyph = (chain: Pbf[], codepoint: number) => {
  for (const font of chain) {
    try {
      return { glyph: font.read(codepoint), font };
    } catch {
      // not in this font, try the next one
    }
  }
  const last = chain[chain.length - 1]!;
  try {
    return { glyph: last.read(last.wildcardCodepoint), font: last };
  } catch {
    return null;
  }
};

// Wrap text at whole-codepoint boundaries so it fits into `width` pixels.
const wrapText = (chain: Pbf[], text: string, width: number) => {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let pendingSpace = "";
  for (const char of text) {
    const glyph = readGlyph(chain, char.codePointAt(0)!)?.glyph;
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

const measureText = (chain: Pbf[], text: string) => {
  let width = 0;
  for (const char of text) {
    width += readGlyph(chain, char.codePointAt(0)!)?.glyph.advance ?? 0;
  }
  return width;
};

const drawText = (
  ctx: Ctx,
  chain: Pbf[],
  text: string,
  x: number,
  baselineY: number,
) => {
  let cursor = x;
  for (const char of text) {
    const found = readGlyph(chain, char.codePointAt(0)!);
    if (!found) continue;
    const { glyph, font } = found;
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

  // Optional fallback: a PBF used for glyphs a row's font is missing, or a
  // directory from which each row picks the fonts of its own pixel height.
  const fallbackFiles: string[] =
    typeof values.fallback === "string"
      ? fs.statSync(path.resolve(values.fallback)).isDirectory()
        ? fs
            .readdirSync(path.resolve(values.fallback))
            .filter((file) => file.endsWith(".pbf"))
            .map((file) => path.resolve(values.fallback as string, file))
        : [path.resolve(values.fallback)]
      : [];
  const fallbacks: LoadedFont[] = fallbackFiles.map((file) => ({
    name: path.basename(file, ".pbf"),
    file,
    font: readPbf(fs.readFileSync(file)),
  }));

  const fallbackFor = (row: LoadedFont) => {
    const bold = row.name.endsWith("_BOLD");
    return fallbacks
      .filter(
        (entry) =>
          entry.file !== row.file &&
          entry.font.maxHeight === row.font.maxHeight,
      )
      .sort(
        (a, b) =>
          Number(b.name.endsWith("_BOLD") === bold) -
            Number(a.name.endsWith("_BOLD") === bold) ||
          a.name.length - b.name.length ||
          a.name.localeCompare(b.name),
      );
  };

  const sampleLines = (
    typeof values.text === "string" ? values.text : DEFAULT_TEXT
  ).split("\n");

  const sheets = loaded.map((loadedFont) => {
    const { font } = loadedFont;
    const fallbackEntries = fallbackFor(loadedFont);
    const chain = [font, ...fallbackEntries.map((entry) => entry.font)];
    const covered = new Set<number>();
    for (const line of sampleLines) {
      for (const char of line) covered.add(char.codePointAt(0)!);
    }
    const available = new Set<number>();
    for (const entry of chain) {
      for (const key of Object.keys(entry.offsetTables)) {
        available.add(Number(key));
      }
    }
    const missing = [...available]
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
    return {
      ...loadedFont,
      chain,
      fallbackName: fallbackEntries[0]?.name ?? "",
      lines,
      missing,
    };
  });

  // Choose a UI font for the labels: prefer stock GOTHIC_14, else the smallest.
  const labelSource =
    loaded.find((entry) => entry.name === "GOTHIC_14") ??
    [...loaded].sort((a, b) => a.font.maxHeight - b.font.maxHeight)[0]!;
  const labelFont = labelSource.font;
  // The labels are Latin, which the specimen fonts often do not have; draw
  // them with the same fallback chain so they are readable.
  const labelChain = [
    labelFont,
    ...fallbackFor(labelSource).map((entry) => entry.font),
  ];

  const margin = 12;
  const padTop = 10;
  const padBottom = 14;
  const labelGap = 6;
  const lineGap = 6;
  const titleGap = 10;

  const commonName = (() => {
    const stems = loaded.map((entry) =>
      entry.name.replace(/_\d+(_BOLD)?$/, ""),
    );
    let prefix = stems[0] ?? "";
    for (const stem of stems) {
      while (prefix && !stem.startsWith(prefix)) prefix = prefix.slice(0, -1);
    }
    return prefix.replace(/[_-]+$/, "");
  })();
  const title =
    typeof values.title === "string"
      ? values.title
      : values.pebble
        ? "PebbleOS firmware fonts"
        : commonName || "Font specimen";
  // The path of a --pebble checkout is worth printing; for explicit PBFs the
  // fonts speak for themselves.
  const subtitle = values.pebble
    ? `${loaded.length} fonts · ${path.resolve(values.pebble as string)}`
    : "";

  const labels = sheets.map(
    ({ name, font, fallbackName }) =>
      `${name}  ·  ${font.maxHeight}px  ·  ${font.numberOfGlyphs} glyphs  ·  ` +
      `${font.features.compressed ? "RLE4" : "plain"}  ·  ${font.features.offsetByteWidth * 8}-bit offsets` +
      (fallbackName ? `  ·  +${fallbackName}` : ""),
  );
  const widestSample = Math.max(
    ...sheets.flatMap((sheet) =>
      sheet.lines.map((line) => measureText(sheet.chain, line)),
    ),
  );
  const contentWidth = Math.max(
    Math.min(widestSample, maxWidth),
    ...labels.map((label) => measureText(labelChain, label)),
  );
  const wrappedLines = sheets.map((sheet) =>
    sheet.lines.flatMap((line) => wrapText(sheet.chain, line, contentWidth)),
  );

  const titleHeight = labelFont.maxHeight * (subtitle ? 2 : 1) + titleGap + 4;
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
  drawText(ctx, labelChain, title, margin, margin + labelFont.maxHeight);
  if (subtitle) {
    ctx.fillStyle = "#666666";
    drawText(
      ctx,
      labelChain,
      subtitle,
      margin,
      margin + labelFont.maxHeight * 2 + titleGap,
    );
  }

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
      labelChain,
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
      drawText(ctx, row.sheet.chain, row.lines[i]!, margin, baselineY);
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
