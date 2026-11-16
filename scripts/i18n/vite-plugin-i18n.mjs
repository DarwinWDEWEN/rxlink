// vite 插件：构建期把上游产物与 src 里的英文字面量替换成中文。
// I18N_LANG=en 时不替换（出英文原版）。
//
// 断言：buildEnd 时对照 expected.json（上游）+ expected.src.json（src）校验每条文案的
// 实际替换次数；不符则抛错，避免上游升级后静默漏翻。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replaceLiterals, replaceTemplates } from './replace-literals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

// country-zh.json 是生成的国家名映射（英文名 → 中文），与手改的 zh-CN.json 合并；
// 冲突时以手改的 zh-CN.json 为准。
const dict = { ...readJson('country-zh.json'), ...readJson('zh-CN.json') };
// 模板字面量（反引号）字典：key 为去掉反引号后的模板体，${...} 原样保留。
const tplDict = readJson('template-cn.json');
// date-fns 的 en-US 相对时间文案（"7 days ago" 之类）。它不在 @shlinkio 产物里，
// 单独用一张表替换，避免主字典里的短键（如 "s"）误伤 date-fns 代码。
const dateFnsDict = readJson('date-fns-cn.json');
const expectedUpstream = readJson('expected.json');
// src 部分的基准是可选的（Task 4 才引入）
let expectedSrc = {};
try {
  expectedSrc = readJson('expected.src.json');
} catch {
  expectedSrc = {};
}
// 同一条文案可能同时出现在上游产物与 src 里，基准要相加而不是覆盖。
const expected = { ...expectedUpstream };
for (const [en, n] of Object.entries(expectedSrc)) {
  expected[en] = (expected[en] ?? 0) + n;
}

// 上游产物（@shlinkio 的两个包 dist）与我们自己的 src
const TARGET_RE = /(@shlinkio\/(shlink-web-component|shlink-frontend-kit)\/dist\/|[/\\]src[/\\])/;
// date-fns 的 en-US locale（相对时间文案）
const DATE_FNS_RE = /date-fns[/\\]locale[/\\]en-US[/\\]/;

// 上游布局补丁：图表 Y 轴标签宽度按「字符数 × 7」估算，中文（全角）会被截断成单字。
// 改成按字符宽度累加（CJK 15px / 其他 7px）并留 4px 余量，英文结果不变。上游改这段代码则构建失败。
const CODE_PATCHES = [
  {
    name: 'chart-axis-label-width',
    from:
      'let e = s.reduce((e, { name: t }) => e > t.length ? e : t.length, 0);\n' +
      '\t\treturn Math.min(150, e * 7);',
    to:
      'let e = s.reduce((e, { name: t }) => Math.max(e, [...t].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? 15 : 7), 0)), 0);\n' +
      '\t\treturn Math.min(150, e + 4);',
  },
  {
    // 排序方向显示：ASC/DESC 是状态值，不能直接翻（会破坏切换逻辑），只改展示文案。
    name: 'order-dir-label',
    from: 't.dir ?? "DESC"',
    to: 't.dir === "ASC" ? "升序" : "降序"',
  },
];

export function i18nPlugin() {
  const enabled = process.env.I18N_LANG !== 'en';
  const counts = {};
  for (const en of Object.keys(dict)) counts[en] = 0;
  const tplCounts = {};
  for (const en of Object.keys(tplDict)) tplCounts[en] = 0;
  const dateFnsCounts = {};
  for (const en of Object.keys(dateFnsDict)) dateFnsCounts[en] = 0;
  const patched = new Set();

  return {
    name: 'rxlink-i18n',
    apply: 'build',
    enforce: 'pre',
    transformIndexHtml(html) {
      const lang = enabled ? 'zh-CN' : 'en';
      return html.replace(/(<html[^>]*\slang=)["'][^"']*["']/i, `$1"${lang}"`);
    },
    transform(code, id) {
      if (!enabled) return undefined;
      if (DATE_FNS_RE.test(id)) {
        const { code: out, counts: c } = replaceLiterals(code, dateFnsDict);
        for (const [k, v] of Object.entries(c)) dateFnsCounts[k] += v;
        return out === code ? undefined : { code: out, map: null };
      }
      if (!TARGET_RE.test(id)) return undefined;
      // 先替换模板字面量（其体内可能含引号字面量），再替换普通引号字面量。
      const tpl = replaceTemplates(code, tplDict);
      for (const [k, v] of Object.entries(tpl.counts)) tplCounts[k] += v;
      const { code: out, counts: c } = replaceLiterals(tpl.code, dict);
      for (const [k, v] of Object.entries(c)) counts[k] += v;
      let result = out;
      for (const p of CODE_PATCHES) {
        if (result.includes(p.from)) {
          result = result.split(p.from).join(p.to);
          patched.add(p.name);
        }
      }
      return result === code ? undefined : { code: result, map: null };
    },
    buildEnd() {
      if (!enabled) return;
      const errors = [];
      for (const [en, exp] of Object.entries(expected)) {
        if (counts[en] !== exp) {
          errors.push(`  ${JSON.stringify(en)}: expected ${exp}, got ${counts[en]}`);
        }
      }
      // 模板字典每条都应命中（未命中说明模板体与上游产物不一致，可能因上游升级而失效）。
      for (const [en, n] of Object.entries(tplCounts)) {
        if (n === 0) errors.push(`  模板未命中 ${JSON.stringify(en)}`);
      }
      // 布局补丁未命中说明上游改了对应代码，需人工复核后更新补丁。
      for (const p of CODE_PATCHES) {
        if (!patched.has(p.name)) errors.push(`  布局补丁未命中 ${p.name}`);
      }
      // date-fns 每条都应命中（未命中说明上游换了 locale 实现）。
      for (const [en, n] of Object.entries(dateFnsCounts)) {
        if (n === 0) errors.push(`  date-fns 未命中 ${JSON.stringify(en)}`);
      }
      if (errors.length > 0) {
        throw new Error(
          `i18n 断言失败（${errors.length} 条）：\n${errors.join('\n')}\n` +
            `提示：上游升级后先跑 node scripts/i18n/gen-expected.mjs 刷新基准，再补字典。`,
        );
      }
    },
  };
}
