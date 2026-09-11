import { ResourcePack } from "../lib/pbl";
import {
  EMERY_LANG_LAYOUT,
  langLayoutFromResourceMap,
  langMapFromDir,
  packLangMap,
  templateLangMap,
  type LangMap,
} from "../lib/langpack";
import { parseArgs } from "util";
import fs from "fs";
import path from "path";

try {
  const { values, positionals } = parseArgs({
    args: process.argv,
    options: {
      system: {
        type: "boolean",
      },
      out: {
        type: "string",
        short: "o",
        default: "///",
      },
      "resource-map": {
        type: "string",
      },
      lang: {
        type: "string",
        default: "en_US",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const operation = positionals[2];

  const getOut = (target: string, fallback: string) => {
    let out = values.out;
    if (out === "///") {
      out = fallback;
    }
    return path.resolve(out);
  };

  if (operation === "unpack") {
    const file = positionals[3];
    if (!file) {
      console.error("No file specified");
      process.exit(1);
    }

    const result = ResourcePack.deserialize(
      fs.readFileSync(file),
      !!values.system,
    );

    const outfileName = getOut(file, file + "_unpack");

    fs.mkdirSync(outfileName, { recursive: true });

    for (let i = 0; i < result.tableEntries.length; i++) {
      const entry = result.tableEntries[i]!;
      const content = result.contents[entry.contentIndex]!;
      fs.writeFileSync(
        path.join(outfileName, `${i.toString().padStart(3, "0")}`),
        content,
      );
    }

    console.log("Unpacked " + result.tableEntries.length + " files");
    process.exit(0);
  }

  if (operation === "pack") {
    const dir = positionals[3];
    if (!dir) {
      console.error("No directory specified");
      process.exit(1);
    }

    const dirname = path.resolve(dir);
    const files = fs
      .readdirSync(dirname, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    const pack = new ResourcePack(values.system ? true : false);
    for (const file of files.sort()) {
      const content = fs.readFileSync(path.join(dirname, file));
      pack.addResource(content);
    }

    const outfileName = getOut(dirname, dirname + ".pbl");
    const buffer = pack.serialize();
    fs.writeFileSync(outfileName, buffer);

    console.log("Packed " + files.length + " files");
    process.exit(0);
  }

  // Build a language pack (.pbl) in the layout the firmware expects. The
  // target is either a PebbleOS lang_map.json or a directory whose files are
  // named after the resource slots.
  if (operation === "packlang") {
    const target = positionals[3];
    if (!target) {
      console.error("No manifest or directory specified");
      process.exit(1);
    }

    const resolvedTarget = path.resolve(target);
    if (!fs.existsSync(resolvedTarget)) {
      console.error(`No such file or directory: ${target}`);
      process.exit(1);
    }

    let layout: string[] | undefined;
    let layoutSource = "built-in Emery layout";
    if (values["resource-map"]) {
      const resourceMap = path.resolve(values["resource-map"] as string);
      layout = langLayoutFromResourceMap(resourceMap);
      layoutSource = resourceMap;
    } else {
      layout = [...EMERY_LANG_LAYOUT];
    }

    let langMap: LangMap;
    let baseDir: string;
    let outFallback: string;

    const stat = fs.statSync(resolvedTarget);
    if (stat.isDirectory()) {
      baseDir = resolvedTarget;
      langMap = langMapFromDir(resolvedTarget, layout);
      outFallback = resolvedTarget + ".pbl";

      const used = new Set(
        [
          langMap.strings?.file,
          ...(langMap.fonts ?? []).map((font) => font.file),
        ].filter((file): file is string => !!file),
      );
      const unused = fs
        .readdirSync(resolvedTarget, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => /\.(pbf|mo|po)$/i.test(name) && !used.has(name));
      if (unused.length > 0) {
        console.warn(`Unused files in ${resolvedTarget}: ${unused.join(", ")}`);
      }
    } else {
      baseDir = path.dirname(resolvedTarget);
      langMap = JSON.parse(fs.readFileSync(resolvedTarget, "utf8")) as LangMap;
      outFallback = resolvedTarget.replace(/\.json$/i, "") + ".pbl";
    }

    const outfileName = getOut(resolvedTarget, outFallback);
    console.log(`Using language layout from ${layoutSource}`);
    const result = packLangMap(langMap, baseDir, outfileName, layout);

    for (const warning of result.warnings) {
      console.warn(`Warning: ${warning}`);
    }
    if (result.emptySlots.length > 0) {
      console.log(`Empty slots: ${result.emptySlots.join(", ")}`);
    }
    console.log(
      `Wrote ${result.resourceCount} resources ` +
        `(${result.uniqueContents} unique, ${result.bytes} bytes) to ${outfileName}`,
    );
    process.exit(0);
  }

  // Print an editable language pack manifest for the target firmware.
  if (operation === "langmap") {
    const layout = values["resource-map"]
      ? langLayoutFromResourceMap(
          path.resolve(values["resource-map"] as string),
        )
      : [...EMERY_LANG_LAYOUT];

    const outfileName = getOut("lang_map.json", "lang_map.json");
    const manifest = templateLangMap(layout, values.lang as string);
    fs.writeFileSync(outfileName, JSON.stringify(manifest, null, 4) + "\n");
    console.log(
      `Wrote ${layout.length} resource slots to ${outfileName}. ` +
        `Fill in the "file" fields with .pbf/.mo paths and run packlang.`,
    );
    process.exit(0);
  }

  console.error("Unknown operation: " + operation);
  console.error("Operations: unpack, pack, packlang, langmap");
  process.exit(1);
} catch (err: any) {
  console.error(err?.message || err);
  process.exit(1);
}
