import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

import { ResourcePack } from "./pbl";

/**
 * Language packs for PebbleOS are regular resource packs (`.pbl`) installed
 * as the PFS file `lang`. Their resources are addressed by position, so the
 * order below is load-bearing:
 *
 *   entry 1 -> RESOURCE_ID_STRINGS
 *   entry 2 -> RESOURCE_ID_STRINGS + 1
 *   ...
 *
 * The firmware's `lang` file resource list (and therefore the resource ids)
 * comes from `resources/normal/base/resource_map.json` in a PebbleOS
 * checkout. `Extended` fonts in that list shadow the built-in GOTHIC/BITHAM
 * fonts once the pack is installed.
 *
 * This layout matches the current PebbleOS tree (Emery / Pebble Time 2 and
 * the other normal-variant platforms, which share the base resource map).
 * Use `--resource-map` to derive the layout from a specific checkout when
 * packing for an older firmware.
 */
export const EMERY_LANG_LAYOUT: readonly string[] = [
  "STRINGS",
  "GOTHIC_14_EXTENDED",
  "GOTHIC_14_BOLD_EXTENDED",
  "GOTHIC_18_EXTENDED",
  "GOTHIC_18_BOLD_EXTENDED",
  "GOTHIC_24_EXTENDED",
  "GOTHIC_24_BOLD_EXTENDED",
  "GOTHIC_28_EXTENDED",
  "GOTHIC_28_BOLD_EXTENDED",
  "GOTHIC_36_EXTENDED",
  "GOTHIC_36_BOLD_EXTENDED",
  "BITHAM_18_LIGHT_SUBSET_EXTENDED",
  "BITHAM_30_BLACK_EXTENDED",
  "BITHAM_34_LIGHT_SUBSET_EXTENDED",
  "BITHAM_34_MEDIUM_NUMBERS_EXTENDED",
  "BITHAM_42_BOLD_EXTENDED",
  "BITHAM_42_LIGHT_EXTENDED",
  "BITHAM_42_MEDIUM_NUMBERS_EXTENDED",
  "ROBOTO_CONDENSED_21_EXTENDED",
  "ROBOTO_BOLD_SUBSET_49_EXTENDED",
  "DROID_SERIF_28_BOLD_EXTENDED",
];

/**
 * Read the ordered resource list of the `lang` file from a PebbleOS
 * resource_map.json (e.g. resources/normal/base/resource_map.json).
 */
export const langLayoutFromResourceMap = (
  resourceMapPath: string,
): string[] => {
  const resourceMap = JSON.parse(fs.readFileSync(resourceMapPath, "utf8"));
  const langFile = (resourceMap.files ?? []).find(
    (file: { name?: string }) => file.name === "lang",
  );
  if (!langFile || !Array.isArray(langFile.resources)) {
    throw new Error(`${resourceMapPath} does not declare a "lang" file`);
  }
  return langFile.resources.map(String);
};

/**
 * A PebbleOS `lang_map.json`-compatible manifest. `file` paths are resolved
 * relative to the manifest's directory. An empty `file` packs an empty
 * resource, which makes the firmware fall back to the built-in font for that
 * slot. `alias` reuses the bytes of an earlier resource.
 */
export interface LangMapStrings {
  lang?: string;
  name?: string;
  file?: string;
}

export interface LangMapFont {
  name: string;
  file?: string;
  alias?: string;
}

export interface LangMap {
  strings?: LangMapStrings;
  fonts?: LangMapFont[];
}

export interface LangPackResult {
  resourceCount: number;
  uniqueContents: number;
  bytes: number;
  emptySlots: string[];
  warnings: string[];
}

const compilePo = (poPath: string): Buffer => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbf-lang-"));
  const moPath = path.join(outDir, "strings.mo");
  try {
    const result = spawnSync("msgfmt", ["-c", "-o", moPath, poPath], {
      encoding: "utf8",
    });
    if (result.error) {
      throw new Error(
        `Failed to run msgfmt (is gettext installed?): ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      throw new Error(`msgfmt failed for ${poPath}:\n${result.stderr}`);
    }
    return fs.readFileSync(moPath);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
};

const readResource = (file: string, baseDir: string): Buffer => {
  if (!file) {
    return Buffer.alloc(0);
  }
  const resolved = path.resolve(baseDir, file);
  if (resolved.toLowerCase().endsWith(".po")) {
    return compilePo(resolved);
  }
  return fs.readFileSync(resolved);
};

// The height is the first number in the resource name, matching PebbleOS's
// FontResourceGenerator._get_font_height_from_name.
const heightFromName = (name: string): number | null => {
  const match = /(\d+)/.exec(name);
  return match ? parseInt(match[1]!, 10) : null;
};

const heightFromPbf = (data: Buffer): number | null => {
  // PBF headers start with {version, max_height, ...}. Only check data that
  // is non-empty and looks like a font, so empty placeholders and .mo files
  // are not mistaken for mismatched fonts.
  if (data.length < 10 || data[0] !== 3) {
    return null;
  }
  return data[1]!;
};

export const packLangMap = (
  langMap: LangMap,
  baseDir: string,
  outFile: string,
  expectedLayout?: readonly string[],
): LangPackResult => {
  const stringsName = langMap.strings?.name || "STRINGS";
  const entries: { name: string; data: Buffer }[] = [];
  const byName = new Map<string, Buffer>();
  const warnings: string[] = [];

  const stringsData = readResource(langMap.strings?.file ?? "", baseDir);
  byName.set(stringsName, stringsData);
  entries.push({ name: stringsName, data: stringsData });

  for (const font of langMap.fonts ?? []) {
    if (!font.name) {
      throw new Error("Every font entry needs a name");
    }
    if (byName.has(font.name)) {
      throw new Error(`Duplicate resource name ${font.name}`);
    }

    let data: Buffer;
    if (font.alias) {
      const aliased = byName.get(font.alias);
      if (!aliased) {
        throw new Error(
          `Font ${font.name} aliases ${font.alias}, which is not defined before it`,
        );
      }
      data = aliased;
    } else {
      data = readResource(font.file ?? "", baseDir);
    }
    byName.set(font.name, data);
    entries.push({ name: font.name, data });
  }

  // Sanity-check the slot names against the layout the target firmware
  // expects; a shifted pack silently shows the wrong font for many slots.
  const actualNames = entries.map((entry) => entry.name);
  if (expectedLayout && expectedLayout.length > 0) {
    if (actualNames.length !== expectedLayout.length) {
      warnings.push(
        `Pack has ${actualNames.length} resources but the target layout has ` +
          `${expectedLayout.length}; resources will be misaligned.`,
      );
    }
    for (
      let i = 0;
      i < Math.min(actualNames.length, expectedLayout.length);
      i++
    ) {
      const expected = expectedLayout[i]!;
      if (actualNames[i] !== expected) {
        warnings.push(
          `Slot ${i + 1}: pack has ${actualNames[i]} but the target layout expects ${expected}`,
        );
      }
    }
  }

  for (const entry of entries) {
    const expectedHeight = heightFromName(entry.name);
    const packedHeight = heightFromPbf(entry.data);
    if (
      expectedHeight !== null &&
      packedHeight !== null &&
      expectedHeight !== packedHeight
    ) {
      warnings.push(
        `${entry.name}: PBF max height is ${packedHeight}, expected ${expectedHeight}`,
      );
    }
  }

  const pack = new ResourcePack(false);
  for (const entry of entries) {
    pack.addResource(entry.data);
  }
  const buffer = pack.serialize();
  fs.writeFileSync(outFile, buffer);

  return {
    resourceCount: entries.length,
    uniqueContents: pack.contents.length,
    bytes: buffer.length,
    emptySlots: entries
      .filter((entry) => entry.data.length === 0)
      .map((entry) => entry.name),
    warnings,
  };
};

/**
 * Build a manifest from a directory whose files are named after their
 * resource slots: `STRINGS(.mo|.po)`, `GOTHIC_14_EXTENDED.pbf`, and so on.
 * Missing slots are packed empty.
 */
export const langMapFromDir = (
  dir: string,
  layout: readonly string[],
): LangMap => {
  const find = (name: string): string => {
    for (const suffix of ["", ".pbf", ".mo", ".po"]) {
      const candidate = path.join(dir, name + suffix);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return name + suffix;
      }
    }
    return "";
  };

  const [stringsName = "STRINGS", ...fontNames] = layout;
  return {
    strings: { name: stringsName, file: find(stringsName) },
    fonts: fontNames.map((name) => ({ name, file: find(name) })),
  };
};

/** An editable manifest with every slot present and empty. */
export const templateLangMap = (
  layout: readonly string[],
  lang: string = "en_US",
): LangMap => {
  const [stringsName = "STRINGS", ...fontNames] = layout;
  return {
    strings: { lang, name: stringsName, file: "" },
    fonts: fontNames.map((name) => ({ name, file: "" })),
  };
};
