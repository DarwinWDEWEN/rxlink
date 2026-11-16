// 生成国家名中文映射（两处产物，同源保证一致）：
//   1) scripts/i18n/country-zh.json  —— 键是上游产物里的英文名（国家下拉/过滤器的 option 文案），
//      供 vite-plugin-i18n 合并进字典做构建期字面量替换；
//   2) supabase/functions/compat/country-zh.ts —— 键是 ISO alpha-2 代码，
//      供兼容层把访问数据里的 countryCode 翻成中文（访问表/概览统计是国家名，来自运行时数据）。
//
// 数据来源：Node 内置 Intl.DisplayNames（CLDR）。不引第三方数据集。
// 上游英文名与 CLDR 英文名不一致时（如 Curacao/Curaçao、Swaziland/Eswatini），
// 以「代码」为纽带对齐——从上游映射块里读代码，再用代码取中文。
//
// 用法：node scripts/i18n/gen-country-dict.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const BUNDLE = join(
  ROOT, 'shlink-web-client', 'node_modules', '@shlinkio', 'shlink-web-component', 'dist', 'index.js',
);

// 少量人工修正：CLDR 的全称在窄表格里过长，或与官方口径不同
const OVERRIDES = {
  HK: '中国香港',
  MO: '中国澳门',
  TW: '中国台湾',
  AN: '荷属安的列斯',
  PS: '巴勒斯坦',
  BA: '波黑',
  CD: '刚果（金）',
  CG: '刚果（布）',
};

const dn = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const zhOf = (code) => {
  if (OVERRIDES[code]) return OVERRIDES[code];
  try {
    const v = dn.of(code);
    return v && v !== code ? v : null;
  } catch {
    return null;
  }
};

// ---- 1) 上游映射块：代码 → 上游英文名（只取 AF..ZW 这一段，避免误收别的对象） ----
const src = readFileSync(BUNDLE, 'utf8');
const start = src.indexOf('AF: "Afghanistan"');
const end = src.indexOf('ZW: "Zimbabwe"');
if (start < 0 || end < 0) throw new Error('找不到上游国家名映射块，可能上游已升级，请人工核对');
const block = src.slice(start, end + 'ZW: "Zimbabwe"'.length);
const pairs = [...block.matchAll(/([A-Z]{2}): "([^"]+)"/g)].map((m) => [m[1], m[2]]);

const byEn = {};
const byCode = {};
for (const [code, en] of pairs) {
  const zh = zhOf(code);
  if (!zh) {
    console.warn(`[country-zh] 警告：${code}/${en} 没有中文名，保持英文`);
    continue;
  }
  byEn[en] = zh;
  byCode[code] = zh;
}
writeFileSync(
  join(here, 'country-zh.json'),
  JSON.stringify(Object.fromEntries(Object.entries(byEn).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n',
);
console.log(`[country-zh] country-zh.json：上游英文名 ${Object.keys(byEn).length} 条`);

// ---- 2) 全量 ISO alpha-2 代码表（访问数据里可能出现任意国家代码） ----
for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a) + String.fromCharCode(b);
    const zh = zhOf(code);
    if (zh) byCode[code] = zh;
  }
}
const lines = Object.entries(byCode)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, zh]) => `  ${code}: ${JSON.stringify(zh)},`)
  .join('\n');
const ts = `// 本文件由 scripts/i18n/gen-country-dict.mjs 生成，请勿手改。
// ISO alpha-2 国家/地区代码 → 中文名（CLDR）。兼容层用它把访问数据里的 countryCode 翻成中文。
export const COUNTRY_ZH: Record<string, string> = {
${lines}
};
`;
writeFileSync(join(ROOT, 'supabase', 'functions', 'compat', 'country-zh.ts'), ts);
console.log(`[country-zh] country-zh.ts：ISO 代码 ${Object.keys(byCode).length} 条`);
