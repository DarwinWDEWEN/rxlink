// 按字典替换代码里的英文字面量。只替换完整的双引号字面量，不做子串替换。
// 中文字面量用 JSON.stringify 生成，正确处理引号与反斜杠。
export function replaceLiterals(code, dict) {
  const counts = {};
  let out = code;
  for (const [en, zh] of Object.entries(dict)) {
    const literal = JSON.stringify(en);
    const replacement = JSON.stringify(zh);
    const parts = out.split(literal);
    const n = parts.length - 1;
    if (n > 0) {
      out = parts.join(replacement);
      counts[en] = (counts[en] ?? 0) + n;
    }
  }
  return { code: out, counts };
}
