// 扫描上游产物，统计候选 UI 文案的出现次数，产出 expected.json。
// 同时扫描 shlink-web-client/src，统计字典里每条文案的出现次数，产出 expected.src.json。
// 上游升级或 src 改动后重跑本脚本即可刷新基准：node scripts/i18n/gen-expected.mjs
//
// 三类候选会被自动剔除，不进入 expected.json：
//   1) 数据值（国家名，`KEY: "Value"` 大对象）—— 由下方 objRe 识别；
//   2) 数据值（浏览器/OS/城市名，数组形式）—— 由 KEEP_EN 列表维护；
//   3) 逻辑 key / 内部标识 —— 由 LOGICAL_KEYS 列表维护（新上游版本如出现新的，需补进列表）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replaceLiterals } from './replace-literals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', 'shlink-web-client', 'node_modules', '@shlinkio');
const bundles = [
  join(root, 'shlink-web-component', 'dist', 'index.js'),
  join(root, 'shlink-web-component', 'dist', 'settings-BOILmGcF.js'),
  join(root, 'shlink-frontend-kit', 'dist', 'index.js'),
];
const texts = bundles.map((f) => readFileSync(f, 'utf8'));

// 逻辑 key / 内部标识：不是显示文案，替换会改坏逻辑（组件名、排序标识、键盘键名、类名等）
const LOGICAL_KEYS = new Set([
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp',
  'ASC', 'DESC', 'DEFAULT',
  'Backspace', 'Enter', 'Escape',
  'Card', 'Card.Body', 'Card.Footer', 'Card.Header',
  'ColorGenerator', 'Dropdown', 'ImageDownloader', 'Invalid parent element',
  'Menu', 'Menu.Item', 'Menu.Misc', 'Menu.Separator', 'Menu.Title',
  'Module',
  'NavBar', 'NavBar.Dropdown', 'NavBar.MenuItem',
  'NavPills', 'NavPills.Pill',
  'No draggable item found from external drag handle callback',
  'No values found for parent element',
  'ReportExporter', 'RowDropdown',
  'Table', 'Table.Cell', 'Table.Row',
  'TagColorsStorage', 'VisitsParser',
]);

// 数据值（浏览器/OS/城市名，以数组形式出现，objRe 识别不到）：保留英文，不翻译
const KEEP_EN = new Set([
  'Android', 'Android browser', 'Android Browser',
  'Chrome', 'ChromeOS', 'Chromium',
  'Firefox', 'Google Chrome', 'Internet Explorer',
  'Linux', 'Macintosh', 'MacOS', 'Microsoft Edge', 'Mozilla Firefox',
  'New York', 'Opera', 'Safari', 'Samsung Internet for Android',
  'Vivaldi', 'WeChat', 'Windows',
]);

// 数据值（国家名/浏览器名等）识别：形如 KEY: "Value" 的大对象
const objRe = /=\s*\{\s*((?:[A-Za-z0-9_]{2,12}\s*:\s*"[^"]{1,40}",?\s*){5,})\}/g;
const dataVals = new Set();
for (const src of texts) {
  for (const m of src.matchAll(objRe)) {
    for (const [, v] of m[1].matchAll(/:\s*"([^"]*)"/g)) dataVals.add(v);
  }
}

// UI 文案候选
const uiRe = /"([A-Z][A-Za-z0-9 ,.'!?()/%&-]{2,60})"/g;
const counts = {};
for (const src of texts) {
  for (const m of src.matchAll(uiRe)) {
    if (dataVals.has(m[1]) || LOGICAL_KEYS.has(m[1]) || KEEP_EN.has(m[1])) continue;
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
}
const sorted = Object.fromEntries(
  Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(here, 'expected.json'), JSON.stringify(sorted, null, 2) + '\n');
console.log(
  `上游候选 ${Object.keys(sorted).length} 条，出现 ${Object.values(sorted).reduce((a, b) => a + b, 0)} 处`,
);

// ---- src 部分：统计字典里每条文案在 src 下的出现次数（双/单引号字面量，与插件替换口径一致）----
const dict = JSON.parse(readFileSync(join(here, 'zh-CN.json'), 'utf8'));
const srcDir = join(here, '..', '..', 'shlink-web-client', 'src');
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
const { counts: srcCounts } = replaceLiterals(
  walk(srcDir).map((f) => readFileSync(f, 'utf8')).join('\n'),
  dict,
);
const sortedSrc = Object.fromEntries(
  Object.entries(srcCounts).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(here, 'expected.src.json'), JSON.stringify(sortedSrc, null, 2) + '\n');
console.log(
  `src 命中 ${Object.keys(sortedSrc).length} 条，出现 ${Object.values(sortedSrc).reduce((a, b) => a + b, 0)} 处`,
);
