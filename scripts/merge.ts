// Merge glyphs from one glyph project into another, without overwriting any
// file that already exists. This is the staging -> shipping step, e.g.
//
//   bun run ./PebbleFontTool/scripts/merge.ts fonts/TEST_FZ fonts/TUMBLED_18
//
// Only glyphs whose codepoint is in ./build/pages.txt are merged (pass --all
// to ignore the page set). Shapes referenced by the merged glyphs are copied
// too, so composed glyphs keep working. Nothing is written unless --write is
// passed; the default is a dry run.

import fs from "fs";
import path from "path";
import { parseArgs } from "util";

const { values, positionals } = parseArgs({
  args: process.argv,
  strict: false,
  allowPositionals: true,
  options: {
    write: { type: "boolean", short: "w" },
    all: { type: "boolean" },
    pages: { type: "string" },
  },
});

const from = positionals[2];
const to = positionals[3];
if (!from || !to) {
  console.error(
    "Usage: bun run ./PebbleFontTool/scripts/merge.ts <from> <to> [--write] [--all] [--pages build/pages.txt]",
  );
  process.exit(1);
}

const glyphDir = (project: string) => path.join(project, "glyphs");
const shapeDir = (project: string) => path.join(project, "shapes");

for (const dir of [
  glyphDir(from),
  shapeDir(from),
  glyphDir(to),
  shapeDir(to),
]) {
  if (!fs.existsSync(dir)) {
    console.error(`Not a glyph project: ${dir} does not exist`);
    process.exit(1);
  }
}

const height = (project: string): number | undefined => {
  const file = path.join(project, "font.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")).height;
};

const fromHeight = height(from);
const toHeight = height(to);
if (
  fromHeight !== undefined &&
  toHeight !== undefined &&
  fromHeight !== toHeight
) {
  console.warn(
    `WARNING: ${from} is height ${fromHeight} but ${to} is height ${toHeight}; ` +
      `shapes will be copied at the source size.`,
  );
}

const pagesFile = values.pages ?? "./build/pages.txt";
const pages = new Set<number>();
if (!values.all) {
  if (!fs.existsSync(pagesFile)) {
    console.error(`${pagesFile} not found; pass --all to ignore the page set`);
    process.exit(1);
  }
  for (const char of fs.readFileSync(pagesFile, "utf8")) {
    pages.add(char.codePointAt(0)!);
  }
}

// glyph files that exist in `from` but not in `to`
const glyphsToAdd: string[] = [];
for (const file of fs.readdirSync(glyphDir(from)).sort()) {
  if (!file.endsWith(".txt")) continue;
  const codepoint = parseInt(file);
  if (isNaN(codepoint)) {
    console.warn(`WARNING: invalid glyph file name: ${file}`);
    continue;
  }
  if (!values.all && !pages.has(codepoint)) continue;
  if (fs.existsSync(path.join(glyphDir(to), file))) continue;
  glyphsToAdd.push(file);
}

// every shape referenced by the glyphs we are about to add
const referenced = new Set<string>();
let brokenRefs = 0;
for (const file of glyphsToAdd) {
  const content = fs.readFileSync(path.join(glyphDir(from), file), "utf8");
  for (const line of content.split("\n").slice(1)) {
    const name = line.trim() ? line.split(" ")[2] : undefined;
    if (!name) continue;
    referenced.add(name);
    if (!fs.existsSync(path.join(shapeDir(from), `${name}.txt`))) {
      console.warn(`WARNING: ${file} references missing shape ${name}`);
      brokenRefs++;
    }
  }
}

const shapesToAdd = [...referenced]
  .filter((name) => !fs.existsSync(path.join(shapeDir(to), `${name}.txt`)))
  .sort();

console.log(`Merge ${from} -> ${to} ${values.write ? "[write]" : "[dry run]"}`);
console.log(`  glyphs to add: ${glyphsToAdd.length}`);
console.log(`  shapes to add: ${shapesToAdd.length}`);
if (brokenRefs > 0) {
  console.log(`  broken references in source: ${brokenRefs}`);
}
if (!values.write) {
  console.log("  (pass --write to copy)");
} else {
  for (const file of glyphsToAdd) {
    fs.copyFileSync(
      path.join(glyphDir(from), file),
      path.join(glyphDir(to), file),
    );
  }
  for (const name of shapesToAdd) {
    fs.copyFileSync(
      path.join(shapeDir(from), `${name}.txt`),
      path.join(shapeDir(to), `${name}.txt`),
    );
  }
  console.log(`  wrote ${glyphsToAdd.length + shapesToAdd.length} files`);
}
