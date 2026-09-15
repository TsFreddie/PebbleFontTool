/**
 * Derive an edit overlay from a pack by comparing it with a plain extraction.
 *
 * A pack's hand tuning shows up in two places: the bitmap of a glyph and its
 * advance (a half-width ℃, say). This compares a pack against a freshly
 * extracted, pass-free copy of the same font and writes every glyph that
 * differs either way into an edit directory, which
 * `scripts/merge.ts --overwrite` can put back after a regeneration.
 *
 * Usage:
 *   bun run bin/edits.ts <pack dir> <plain extraction dir> <out edit dir>
 */
import fs from "fs";
import path from "path";
import { parseArgs } from "util";

const { positionals } = parseArgs({
  args: process.argv,
  strict: false,
  allowPositionals: true,
});

const [pack, plain, out] = positionals.slice(2);
if (!pack || !plain || !out) {
  console.error(
    "usage: bun run bin/edits.ts <pack dir> <plain extraction dir> <out edit dir>",
  );
  process.exit(1);
}

const glyphFile = (dir: string, name: string) =>
  path.join(dir, "glyphs", `${name}.txt`);
const shapeFile = (dir: string, name: string) =>
  path.join(dir, "shapes", `${name}.txt`);

const advance = (dir: string, name: string) => {
  const file = glyphFile(dir, name);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8").split("\n")[0]?.trim();
};

/** the shape names a glyph references (usually just its own codepoint) */
const shapeNames = (dir: string, name: string) => {
  const file = glyphFile(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .slice(1)
    .map((line) => (line.trim() ? line.split(" ")[2] : undefined))
    .filter((n): n is string => Boolean(n));
};

const shapeOf = (dir: string, name: string) => {
  return shapeNames(dir, name)
    .map((shapeName) => {
      const file = path.join(dir, "shapes", `${shapeName}.txt`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    })
    .join("\n");
};

const codepoints = fs
  .readdirSync(path.join(pack, "glyphs"))
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.split(".")[0]!)
  .filter((name) => name !== "" && !isNaN(Number(name)));

const edits: { name: string; shape: boolean; advance: boolean }[] = [];
for (const name of codepoints) {
  if (!fs.existsSync(glyphFile(plain, name))) continue;
  const shapeDiffers = shapeOf(pack, name) !== shapeOf(plain, name);
  const advanceDiffers = advance(pack, name) !== advance(plain, name);
  if (shapeDiffers || advanceDiffers) {
    edits.push({ name, shape: shapeDiffers, advance: advanceDiffers });
  }
}

if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
for (const kind of ["shapes", "glyphs"]) {
  fs.mkdirSync(path.join(out, kind), { recursive: true });
}
const shapesSeen = new Set<string>();
for (const { name } of edits) {
  fs.copyFileSync(glyphFile(pack, name), glyphFile(out, name));
  for (const shapeName of shapeNames(pack, name)) {
    const from = path.join(pack, "shapes", `${shapeName}.txt`);
    if (!fs.existsSync(from) || shapesSeen.has(shapeName)) continue;
    shapesSeen.add(shapeName);
    fs.copyFileSync(from, path.join(out, "shapes", `${shapeName}.txt`));
  }
}
if (fs.existsSync(path.join(pack, "font.json"))) {
  fs.copyFileSync(path.join(pack, "font.json"), path.join(out, "font.json"));
}

const rows = edits
  .map(
    (e) =>
      `| ${chr(e.name)} | U+${Number(e.name).toString(16).toUpperCase().padStart(4, "0")} | ` +
      `${e.shape ? "yes" : "no"} | ${e.advance ? "yes" : "no"} |`,
  )
  .join("\n");
fs.writeFileSync(
  path.join(out, "README.md"),
  [
    `# ${path.basename(out)}`,
    "",
    `Hand-tuned glyphs of ${path.basename(pack)} that a plain extraction of the`,
    "source font does not produce. Put them back after regenerating with:",
    "",
    "```bash",
    `bun run ./PebbleFontTool/scripts/merge.ts ${path.relative(process.cwd(), out)} ${path.relative(process.cwd(), pack)} --overwrite --write`,
    "```",
    "",
    "...before running the stem passes (`bin/stem.ts <pack> --in-place`).",
    "",
    "| glyph | codepoint | shape | advance |",
    "|---|---|---|---|",
    rows,
    "",
  ].join("\n"),
);

console.log(
  `${edits.length} hand-tuned glyphs written to ${out} ` +
    `(${edits.filter((e) => e.shape).length} with a different shape, ` +
    `${edits.filter((e) => e.advance).length} with a different advance)`,
);

function chr(name: string) {
  return String.fromCodePoint(Number(name));
}
