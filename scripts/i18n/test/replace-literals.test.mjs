// replaceLiterals 的单元测试。
// 运行：node --test scripts/i18n/test/replace-literals.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replaceLiterals } from '../replace-literals.mjs';
import { i18nPlugin } from '../vite-plugin-i18n.mjs';

describe('replaceLiterals', () => {
  it('替换完整字面量', () => {
    const dict = { Save: '保存', Cancel: '取消' };
    const { code, counts } = replaceLiterals('const a = "Save"; const b = "Cancel";', dict);
    assert.equal(code, 'const a = "保存"; const b = "取消";');
    assert.deepEqual(counts, { Save: 1, Cancel: 1 });
  });

  it('不替换子串（避免误伤）', () => {
    const dict = { Save: '保存' };
    const { code, counts } = replaceLiterals('const a = "Save all"; const b = "Save";', dict);
    assert.equal(code, 'const a = "Save all"; const b = "保存";');
    assert.deepEqual(counts, { Save: 1 });
  });

  it('同一文案多处出现全部替换并计数', () => {
    const dict = { 'Saving...': '保存中…' };
    const { code, counts } = replaceLiterals('"Saving..." + "Saving..."', dict);
    assert.equal(code, '"保存中…" + "保存中…"');
    assert.deepEqual(counts, { 'Saving...': 2 });
  });

  it('中文含引号时正确转义', () => {
    const dict = { Hello: '你好"世界"' };
    const { code } = replaceLiterals('const a = "Hello";', dict);
    assert.equal(code, 'const a = "你好\\"世界\\"";');
  });

  it('中文含反斜杠时正确转义', () => {
    const dict = { Path: '路径\\目录' };
    const { code } = replaceLiterals('const a = "Path";', dict);
    assert.equal(code, 'const a = "路径\\\\目录";');
  });

  it('字典外的文案原样保留', () => {
    const { code, counts } = replaceLiterals('const a = "Untranslated";', { Save: '保存' });
    assert.equal(code, 'const a = "Untranslated";');
    assert.deepEqual(counts, {});
  });

  it('空字典不改动', () => {
    const { code, counts } = replaceLiterals('const a = "Save";', {});
    assert.equal(code, 'const a = "Save";');
    assert.deepEqual(counts, {});
  });

  it('带尾随空格的文案精确匹配', () => {
    const dict = { 'Tag ': '标签 ' };
    const { code, counts } = replaceLiterals('children: ["Tag ", x]', dict);
    assert.equal(code, 'children: ["标签 ", x]');
    assert.deepEqual(counts, { 'Tag ': 1 });
  });

  it('单引号包裹的同内容字面量也被替换（仓库格式化器 oxfmt 默认单引号）', () => {
    const dict = { Save: '保存' };
    const { code, counts } = replaceLiterals("const a = 'Save';", dict);
    assert.equal(code, "const a = '保存';");
    assert.deepEqual(counts, { Save: 1 });
  });

  it('同一文案双引号与单引号各出现一次时分别计数', () => {
    const dict = { Save: '保存' };
    const { code, counts } = replaceLiterals(`const a = "Save"; const b = 'Save';`, dict);
    assert.equal(code, `const a = "保存"; const b = '保存';`);
    assert.deepEqual(counts, { Save: 2 });
  });

  it('替换后保持原引号风格', () => {
    const dict = { Connect: '连接' };
    const { code } = replaceLiterals(`<Icon /> {'Connect'}`, dict);
    assert.equal(code, `<Icon /> {'连接'}`);
  });

  it('中文含单引号时用单引号风格正确转义', () => {
    const dict = { Note: "备注'附" };
    const { code } = replaceLiterals("const a = 'Note';", dict);
    assert.equal(code, `const a = '备注\\'附';`);
  });

  it('完整标题模板一次替换并保留变量占位符', () => {
    const dict = { 'Edit "{serverName}"': '编辑“{serverName}”' };
    const { code, counts } = replaceLiterals(
      `const title = 'Edit "{serverName}"';`,
      dict,
    );

    assert.equal(code, `const title = '编辑“{serverName}”';`);
    assert.deepEqual(counts, { 'Edit "{serverName}"': 1 });
  });

  it('键含非 ASCII 时匹配源码里的转义形态（\\xNN）', () => {
    const dict = { 'When the\xa0': '当' };
    const { code, counts } = replaceLiterals('"When the\\xA0"', dict);
    assert.equal(code, '"当"');
    assert.deepEqual(counts, { 'When the\xa0': 1 });
  });

  it('键含非 ASCII 时同时匹配字面量与转义两种形态', () => {
    const dict = { 'a\xa0b': 'X' };
    const { code, counts } = replaceLiterals('"a\\xA0b" + "a\xa0b"', dict);
    assert.equal(code, '"X" + "X"');
    assert.deepEqual(counts, { 'a\xa0b': 2 });
  });
});

describe('i18nPlugin', () => {
  it('只在构建阶段生效', () => {
    assert.equal(i18nPlugin().apply, 'build');
  });

  it('中文构建声明 zh-CN', () => {
    const previous = process.env.I18N_LANG;
    delete process.env.I18N_LANG;
    try {
      const plugin = i18nPlugin();
      assert.match(plugin.transformIndexHtml('<html lang="en">'), /<html lang="zh-CN">/);
    } finally {
      if (previous === undefined) delete process.env.I18N_LANG;
      else process.env.I18N_LANG = previous;
    }
  });

  it('英文构建声明 en', () => {
    const previous = process.env.I18N_LANG;
    process.env.I18N_LANG = 'en';
    try {
      const plugin = i18nPlugin();
      assert.match(plugin.transformIndexHtml('<html lang="zh-CN">'), /<html lang="en">/);
    } finally {
      if (previous === undefined) delete process.env.I18N_LANG;
      else process.env.I18N_LANG = previous;
    }
  });
});
