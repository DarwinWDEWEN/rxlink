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

// 与 quote 类似，但把非 ASCII 字符写成 JS 转义（\xNN / \uNNNN），用于匹配源码里
// 以转义形式出现的非 ASCII 字面量（如 "When the\xA0"）。仅在键含非 ASCII 时需要。
function quoteEscaped(s, q) {
  let body = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      body += ch === '\\' ? '\\\\' : ch === q ? `\\${q}` : ch;
    } else if (code <= 0xff) {
      body += `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    } else if (code <= 0xffff) {
      body += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      const hi = 0xd800 + ((code - 0x10000) >> 10);
      const lo = 0xdc00 + ((code - 0x10000) & 0x3ff);
      body += `\\u${hi.toString(16)}\\u${lo.toString(16)}`;
    }
  }
  return q + body + q;
}

export function replaceLiterals(code, dict) {
  const counts = {};
  let out = code;
  for (const [en, zh] of Object.entries(dict)) {
    for (const q of ['"', "'"]) {
      const literals = [quote(en, q)];
      // 键含非 ASCII 时，额外尝试转义形态（源码可能写成 \xNN / \uNNNN）
      if (!/^[\x00-\x7F]*$/.test(en)) literals.push(quoteEscaped(en, q));
      const replacement = quote(zh, q);
      for (const literal of literals) {
        const parts = out.split(literal);
        const n = parts.length - 1;
        if (n > 0) {
          out = parts.join(replacement);
          counts[en] = (counts[en] ?? 0) + n;
        }
      }
    }
  }
  return { code: out, counts };
}

// 替换模板字面量（反引号）：key 为去掉反引号后的模板体，其中的 ${...} 插值原样保留，
// 因此整段做 split/join 即可（插值与目标产物逐字符一致）。
// 必须在 replaceLiterals 之前执行：模板体内可能含 "s" 之类的引号字面量，先被引号替换会改坏模板体。
export function replaceTemplates(code, dict) {
  const counts = {};
  let out = code;
  for (const [en, zh] of Object.entries(dict)) {
    const parts = out.split('`' + en + '`');
    const n = parts.length - 1;
    if (n > 0) {
      out = parts.join('`' + zh + '`');
      counts[en] = (counts[en] ?? 0) + n;
    }
  }
  return { code: out, counts };
}
