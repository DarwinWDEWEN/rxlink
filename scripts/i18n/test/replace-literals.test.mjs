// replaceLiterals 的单元测试。
// 运行：node --test scripts/i18n/test/replace-literals.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replaceLiterals } from '../replace-literals.mjs';

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

  it('单引号包裹的同内容字面量不被替换（只处理双引号）', () => {
    const dict = { Save: '保存' };
    const { code, counts } = replaceLiterals("const a = 'Save';", dict);
    assert.equal(code, "const a = 'Save';");
    assert.deepEqual(counts, {});
  });
});
