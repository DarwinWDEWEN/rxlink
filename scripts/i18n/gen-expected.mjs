// 扫描上游产物，统计候选 UI 文案的出现次数，产出 expected.json。
// 同时扫描 shlink-web-client/src，统计字典里每条文案的出现次数，产出 expected.src.json。
// 上游升级或 src 改动后重跑本脚本即可刷新基准：node scripts/i18n/gen-expected.mjs
//
// 候选由下方 uiRe 从上游产物里抓取（形如 "Visible text" 的字面量）。
// 两类候选会被自动剔除，不进入 expected.json：
//   1) 数据值（浏览器/OS/城市名，数组形式）—— 由 KEEP_EN 列表维护（国家名不剔除，
//      其翻译由 scripts/i18n/gen-country-dict.mjs 生成 country-zh.json）；
//   2) 逻辑 key / 内部标识 —— 由 LOGICAL_KEYS 列表维护（新上游版本如出现新的，需补进列表）。
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

// 数据值（浏览器/OS/城市名，以数组或小对象形式出现，objRe 识别不到）：保留英文，不翻译
const KEEP_EN = new Set([
  'Android', 'Android browser', 'Android Browser',
  'Chrome', 'ChromeOS', 'Chromium',
  'Firefox', 'Google Chrome', 'Internet Explorer', 'iOS',
  'Linux', 'Macintosh', 'MacOS', 'Microsoft Edge', 'Mozilla Firefox',
  'New York', 'Opera', 'Safari', 'Samsung Internet for Android',
  'Vivaldi', 'WeChat', 'Windows',
]);

// 数据值识别：国家名映射（key 为两位大写国家码）也作为候选项纳入基准——产品要求国家名显示中文，
// 其翻译由 scripts/i18n/gen-country-dict.mjs 依据 Intl.DisplayNames 生成，故这里不再剔除。
// 注意不能放宽为「任意 KEY: "Value" 大对象」，否则设置页列/排序等界面词（如 Visits、Date）
// 会被误判成数据值而漏翻（历史上正是该问题导致 Visits 未翻译）。
// UI 文案候选：允许前导空格/「- 」前缀（如下拉占位「- Select type -」）、冒号结尾的标签、
// 更长的说明句；字符集覆盖常见可见文案，避免误收样式类名（样式类不含空格且多为小写）。
const uiRe = /"( ?-? ?[A-Z][A-Za-z0-9 ,.'!?()/%&#_:-]{1,200})"/g;
const counts = {};
for (const src of texts) {
  for (const m of src.matchAll(uiRe)) {
    if (LOGICAL_KEYS.has(m[1]) || KEEP_EN.has(m[1])) continue;
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
