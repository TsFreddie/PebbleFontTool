# Place-name page sources

These files feed `scripts/combine.ts` through `data/pages/others/`. They are
treated as required coverage (always included, never frequency-cut), so the
`extra` fill spends whatever budget is left after them. One name per line;
the script only cares about the characters.

Local character forms are used deliberately - names come from the region's
own sources, not converted between simplified and traditional:

| File               | Region   | Forms                   | Names | Coverage         |
| ------------------ | -------- | ----------------------- | ----- | ---------------- |
| `中国大陆地名.txt` | 中国大陆 | simplified              | 3306  | 1275/1275 (100%) |
| `臺灣地名.txt`     | 臺灣     | traditional (Taiwan)    | 379   | 315/315 (100%)   |
| `香港地名.txt`     | 香港     | traditional (Hong Kong) | 21    | 39/39 (100%)     |
| `澳門地名.txt`     | 澳門     | traditional (Macau)     | 10    | 27/27 (100%)     |
| `日本地名.txt`     | 日本     | Japanese kanji          | 1901  | 790/790 (100%)   |

The coverage column is unique CJK characters in the final `build/pages.txt`
over unique CJK characters in the file.

## Sources

- **中国大陆地名.txt** - 国家统计局《统计用区划代码和城乡划分代码》,
  via [modood/Administrative-divisions-of-China](https://github.com/modood/Administrative-divisions-of-China)
  (WTFPL). 31 province-level, 342 prefecture-level and 2978 county-level names.
- **臺灣地名.txt** - Chinese Wikipedia
  [中華民國臺灣地區鄉鎮市區列表](https://zh.wikipedia.org/wiki/中華民國臺灣地區鄉鎮市區列表)
  (CC BY-SA 4.0). 22 counties/cities and 368 townships/districts, including
  金門縣 and 連江縣 with their townships.
- **香港地名.txt** - Chinese Wikipedia
  [Template:香港十八區](https://zh.wikipedia.org/wiki/Template:香港十八區)
  (CC BY-SA 4.0). 18 districts plus 香港島/九龍/新界.
- **澳門地名.txt** - Chinese Wikipedia
  [澳門行政區劃](https://zh.wikipedia.org/wiki/澳門行政區劃)
  (CC BY-SA 4.0). The seven parishes plus 澳門半島/氹仔/路環.
- **日本地名.txt** - 総務省「全国地方公共団体コード」
  ([000925834.pdf](https://www.soumu.go.jp/main_content/000925834.pdf),
  令和6年1月1日現在), 政府標準利用規約. 47 prefectures, 1718 municipalities,
  23 special wards and the 政令指定都市 wards.

## Budget

Adding these lists brought the set from 10851 to 10979 codepoints. The PBF
limit is not a glyph count but the 16-bit bucket offset in the hash table:
entries in buckets 0..253 must fit in 64 KiB (10922 entries for 6-byte
entries), and bucket 254 is stored after them. `combine.ts` fills the
remaining budget with frequency-sorted `extra` characters, keeping every
character that was already included, and reserves two slots (the wildcard
glyph plus slack). The generated set currently uses 10921 of 10922 bucket
0..253 entries including the wildcard.
