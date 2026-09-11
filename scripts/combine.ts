// Script to dedup all characters in the CJK directory
import fs from "node:fs";
import path from "path";
import { FontExtractor } from "./extractor";

// The PBF hash table stores each bucket's byte offset in a 16-bit field, so
// the offset tables for buckets 0..253 must fit in 64 KiB. CJK fonts use
// 2-byte codepoints and 4-byte glyph offsets (6 bytes per entry), i.e. at
// most floor(65535 / 6) = 10922 entries. Bucket 254 is stored after them and
// is the only one that does not count against the limit.
const BUCKET_OFFSET_LIMIT = 10922;
const HASH_TABLE_SIZE = 255;
// One slot for the wildcard glyph the extractor always adds, plus slack.
const RESERVED_GLYPHS = 2;

const bucketOf = (char: string) => char.codePointAt(0)! % HASH_TABLE_SIZE;

// Supported in pebble GOTHIC
const ignores = new Set([
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
  89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106,
  107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121,
  122, 123, 124, 125, 126, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169,
  170, 171, 172, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185,
  186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200,
  201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 216,
  217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231,
  232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246,
  247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261,
  262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276,
  277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291,
  292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306,
  307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321,
  322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336,
  337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 350, 351,
  352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366,
  367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381,
  382, 383, 402, 508, 509, 510, 511, 536, 537, 538, 539, 710, 711, 728, 729,
  730, 731, 732, 733, 960, 8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224,
  8225, 8226, 8230, 8240, 8249, 8250, 8260, 8364, 8482, 8486, 8706, 8710, 8719,
  8721, 8722, 8730, 8734, 8747, 8776, 8800, 8804, 8805, 9647, 9674, 63171,
  64257, 64258,

  // newlines
  10, 13,
]);

const __dirname = new URL(".", import.meta.url).pathname;

const listStandards = fs
  .readdirSync(path.resolve(__dirname, "../data/pages/standards"))
  .filter((file) => file.endsWith(".txt"));
const listExtra = fs
  .readdirSync(path.resolve(__dirname, "../data/pages/extra"))
  .filter((file) => file.endsWith(".txt"));
const listOthers = fs
  .readdirSync(path.resolve(__dirname, "../data/pages/others"))
  .filter((file) => file.endsWith(".txt"));

const frequencyMap: Record<string, number> = Object.fromEntries(
  fs
    .readFileSync(path.resolve(__dirname, "../data/FREQUENCY"), "utf8")
    .split("\n")
    .filter((s) => s.trim())
    .map((s) => s.split(",")),
);

const result = new Set<string>();
// Entries in buckets 0..253, the ones limited by the 16-bit hash table offset.
let bucketEntries = 0;
const addResult = (char: string) => {
  result.add(char);
  if (bucketOf(char) !== HASH_TABLE_SIZE - 1) {
    bucketEntries++;
  }
};
const segmentor = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const fileSets: Record<string, Set<string>> = {};

const unifont = new FontExtractor(
  path.resolve(__dirname, "../data/fonts/unifont/unifont-17.0.03.otf"),
);

const isIgnored = (char: string) => {
  const codepoint = char.codePointAt(0);
  if (codepoint === undefined) {
    return false;
  }

  return ignores.has(codepoint);
};

const isSupported = (char: string) => {
  const codepoint = char.codePointAt(0);
  if (codepoint === undefined) {
    console.log(`${char} unsupported codepoints`);
    return false;
  }

  if (codepoint > 65535) {
    console.log(`${char} (${codepoint}) exceeds 16 bits`);
    return false;
  }

  if (!unifont.supportCodePoint(codepoint)) {
    console.log(`${char} (${codepoint}) is not supported by unifont`);
    return false;
  }

  return true;
};

for (const file of listStandards) {
  const content = fs.readFileSync(
    path.resolve(__dirname, `../data/pages/standards/${file}`),
    "utf8",
  );
  const characters = Array.from(segmentor.segment(content))
    .map((s) => s.segment)
    .filter((s) => !isIgnored(s));

  fileSets[file] = new Set(characters);

  for (const char of characters) {
    if (result.has(char) || !isSupported(char)) {
      continue;
    }

    addResult(char);
  }
}

const extras = new Set<string>();

for (const file of listExtra) {
  const content = fs.readFileSync(
    path.resolve(__dirname, `../data/pages/extra/${file}`),
    "utf8",
  );
  const characters = Array.from(segmentor.segment(content))
    .map((s) => s.segment)
    .filter((s) => !isIgnored(s));

  fileSets[file] = new Set(characters);

  for (const char of characters) {
    if (result.has(char) || !isSupported(char)) {
      continue;
    }

    extras.add(char);
  }
}

// `others` are required extras (place names, medicines, ...): include them
// before spending the remaining offset-table budget on frequency-sorted
// `extra` characters.
for (const file of listOthers) {
  const content = fs.readFileSync(
    path.resolve(__dirname, `../data/pages/others/${file}`),
    "utf8",
  );
  const characters = Array.from(segmentor.segment(content))
    .map((s) => s.segment)
    .filter((s) => !isIgnored(s));

  fileSets[file] = new Set(characters);

  for (const char of characters) {
    if (result.has(char) || !isSupported(char)) {
      continue;
    }

    addResult(char);
  }
}

if (bucketEntries > BUCKET_OFFSET_LIMIT) {
  console.error(
    `Required characters need ${bucketEntries} bucket 0..253 entries but the ` +
      `PBF format only allows ${BUCKET_OFFSET_LIMIT}`,
  );
  process.exit(1);
}

// Spend what is left of the offset-table budget on the most frequent extra
// characters. The previous selection is a prefix of this frequency order, so
// growing the budget never drops a character that was already included.
const extraCharacters = Array.from(extras).sort(
  (a, b) => (frequencyMap[b] ?? 0) - (frequencyMap[a] ?? 0),
);
const skippedExtras: string[] = [];
for (const char of extraCharacters) {
  if (result.has(char) || !isSupported(char)) {
    continue;
  }

  // Bucket 254 is stored after the limited buckets and is not counted here.
  if (
    bucketOf(char) !== HASH_TABLE_SIZE - 1 &&
    bucketEntries >= BUCKET_OFFSET_LIMIT - RESERVED_GLYPHS
  ) {
    skippedExtras.push(char);
    continue;
  }

  addResult(char);
}

if (skippedExtras.length > 0) {
  console.log(
    `Removed ${skippedExtras.length} characters: ${skippedExtras.join("")}`,
  );
}

console.log("Deduped all characters in the CJK directory");
console.log(`Total characters: ${result.size}`);
console.log(
  `Bucket 0..253 entries: ${bucketEntries + 1} / ${BUCKET_OFFSET_LIMIT} ` +
    "(including the wildcard glyph)",
);

const resultList = Array.from(result).sort(
  (a, b) => a.codePointAt(0)! - b.codePointAt(0)!,
);

// Print coverage for each txt document
console.log("\n=== Coverage Report ===");
console.log("Standards:");
for (const file of listStandards) {
  const fileSet = fileSets[file];
  const coverage = resultList.filter((c) => fileSet.has(c)).length;
  const total = fileSet.size;
  const percentage = ((coverage / total) * 100).toFixed(2);
  console.log(`  ${file}: ${coverage}/${total} (${percentage}%)`);
}

console.log("\nExtra:");
for (const file of listExtra) {
  const fileSet = fileSets[file];
  const coverage = resultList.filter((c) => fileSet.has(c)).length;
  const total = fileSet.size;
  const percentage = ((coverage / total) * 100).toFixed(2);
  console.log(`  ${file}: ${coverage}/${total} (${percentage}%)`);
}

console.log("\nOthers:");
for (const file of listOthers) {
  const fileSet = fileSets[file];
  const coverage = resultList.filter((c) => fileSet.has(c)).length;
  const total = fileSet.size;
  const percentage = ((coverage / total) * 100).toFixed(2);
  console.log(`  ${file}: ${coverage}/${total} (${percentage}%)`);
}
console.log("========================\n");

fs.mkdirSync("./build", { recursive: true });
fs.writeFileSync("./build/pages.txt", resultList.join(""));
