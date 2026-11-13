// 按字典替换代码里的英文字面量。只替换完整的引号字面量（双引号/单引号），不做子串替换。
// 替换后保持原引号风格：仓库格式化器 oxfmt 默认单引号，含单引号的字符串会写成双引号。
//
// 中文字面量按同一引号风格生成，正确转义反斜杠与该引号字符。

// 生成指定引号风格的字面量
function quote(s, q) {
  // 注意用 split/join 而非 String.replace：replace 的字符串模式只替换第一处，
  // 而中文文案里可能出现多个引号字符。
  const body = s.split('\\').join('\\\\').split(q).join(`\\${q}`);
  return q + body + q;
}

export function replaceLiterals(code, dict) {
  const counts = {};
  let out = code;
  for (const [en, zh] of Object.entries(dict)) {
    for (const q of ['"', "'"]) {
      const literal = quote(en, q);
      const replacement = quote(zh, q);
      const parts = out.split(literal);
      const n = parts.length - 1;
      if (n > 0) {
        out = parts.join(replacement);
        counts[en] = (counts[en] ?? 0) + n;
      }
    }
  }
  return { code: out, counts };
}
