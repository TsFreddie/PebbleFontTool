// A script to extract regional variants by comparing fonts

import fs from "fs";
import { FontExtractor } from "./extractor";
import { basename, extname } from "path";

const baseFont = new FontExtractor(process.argv[2]);
const variants = process.argv.slice(3).map((f) => ({
  extractor: new FontExtractor(f),
  name: basename(f, extname(f)),
}));

const pageFile = "./build/pages.txt";

const segmentor = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = Array.from(
  segmentor.segment(fs.readFileSync(pageFile, "utf8")),
).map((s) => s.segment);

const result = {
  base: basename(process.argv[2], extname(process.argv[2])),
  variants: {} as Record<string, Record<string, string>>,
};

for (const character of characters) {
  const codepoint = character.codePointAt(0)!;
  if (!codepoint) continue;

  const baseGlyph = baseFont.convert(codepoint, 16, 16, true);
  if (!baseGlyph) continue;

  for (const variant of variants) {
    const variantGlyph = variant.extractor.convert(codepoint, 16, 16, true);
    if (!variantGlyph) continue;

    if (baseGlyph.shape !== variantGlyph.shape) {
      result.variants[codepoint] ??= {};
      result.variants[codepoint][variant.name] = variant.name;
    }
  }
}

fs.writeFileSync(`./regional_mapping.json`, JSON.stringify(result, null, 2));
