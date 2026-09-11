# Tumbled Font Editor

This is a font editor specifically designed for tumbled fonts.

## Usage

Before running this tool. You need to generate the reference Unifont font first:

In the root directory of the tumbled project (with PebbleFontTool cloned in),
run:

```bash
bun install
bun run ./PebbleFontTool/scripts/combine.ts # builds build/pages.txt from data/pages
bun run ./PebbleFontTool/scripts/extract.ts # builds fonts/unifont from build/pages.txt
```

To run the tool:

```bash
cd tool
bun install
bun --bun run dev
```
