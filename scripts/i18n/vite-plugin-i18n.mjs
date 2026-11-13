// vite 插件：构建期把上游产物与 src 里的英文字面量替换成中文。
// I18N_LANG=en 时不替换（出英文原版）。
//
// 断言：buildEnd 时对照 expected.json（上游）+ expected.src.json（src）校验每条文案的
// 实际替换次数；不符则抛错，避免上游升级后静默漏翻。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replaceLiterals } from './replace-literals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

const dict = readJson('zh-CN.json');
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

export function i18nPlugin() {
  const enabled = process.env.I18N_LANG !== 'en';
  const counts = {};
  for (const en of Object.keys(dict)) counts[en] = 0;

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
      if (!TARGET_RE.test(id)) return undefined;
      const { code: out, counts: c } = replaceLiterals(code, dict);
      for (const [k, v] of Object.entries(c)) counts[k] += v;
      return out === code ? undefined : { code: out, map: null };
    },
    buildEnd() {
      if (!enabled) return;
      const errors = [];
      for (const [en, exp] of Object.entries(expected)) {
        if (counts[en] !== exp) {
          errors.push(`  ${JSON.stringify(en)}: expected ${exp}, got ${counts[en]}`);
        }
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
