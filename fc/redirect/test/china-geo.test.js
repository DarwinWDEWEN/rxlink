// 中国省级 geo 查表单测：node --test fc/redirect/test/china-geo.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, createLookup } = require('../china-geo');

const BIN = path.join(__dirname, '..', 'china-geo.bin');

function buildFixture() {
  // 手工构造一个最小二进制：2 省 + 3 区间
  const provinces = [
    { en: 'Guangdong', zh: '广东' },
    { en: 'Beijing', zh: '北京' },
  ];
  const nameChunks = [];
  let nameBytes = 0;
  for (const p of provinces) {
    const en = Buffer.from(p.en, 'utf8');
    const zh = Buffer.from(p.zh, 'utf8');
    nameChunks.push(Buffer.from([en.length]), en, Buffer.from([zh.length]), zh);
    nameBytes += 2 + en.length + zh.length;
  }
  const intervals = [
    { start: 0x0a000000, end: 0x0affffff, provId: 0 }, // 10.0.0.0 – 10.255.255.255 广东
    { start: 0x5b000000, end: 0x5b7fffff, provId: 1 }, // 91.0.0.0 – 91.127.255.255 北京
    { start: 0x5b800000, end: 0x5bffffff, provId: 0 }, // 91.128.0.0 – 91.255.255.255 广东
  ];
  const header = Buffer.alloc(16);
  Buffer.from('CNGEO1', 'ascii').copy(header, 0);
  header.writeUInt16LE(provinces.length, 6);
  header.writeUInt32LE(nameBytes, 8);
  header.writeUInt32LE(intervals.length, 12);
  const entries = Buffer.alloc(intervals.length * 9);
  intervals.forEach((iv, i) => {
    entries.writeUInt32BE(iv.start, i * 9);
    entries.writeUInt32BE(iv.end, i * 9 + 4);
    entries.writeUInt8(iv.provId, i * 9 + 8);
  });
  return Buffer.concat([header, Buffer.concat(nameChunks), entries]);
}

test('parse：读出省名表与区间', () => {
  const parsed = parse(buildFixture());
  assert.equal(parsed.provinces.length, 2);
  assert.deepEqual(parsed.provinces[0], { en: 'Guangdong', zh: '广东' });
  assert.equal(parsed.intervals.length, 3);
  assert.equal(parsed.intervals[0].start, 0x0a000000);
  assert.equal(parsed.intervals[0].end, 0x0affffff);
});

test('parse：魔数不对 → 抛错', () => {
  const bad = buildFixture();
  bad.write('XXXXXX', 0, 'ascii');
  assert.throws(() => parse(bad));
});

test('createLookup：命中区间返回中英文省名', () => {
  const lookup = createLookup(buildFixture());
  assert.deepEqual(lookup('10.1.2.3'), { province: 'Guangdong', provinceZh: '广东' });
  assert.deepEqual(lookup('91.1.1.1'), { province: 'Beijing', provinceZh: '北京' });
});

test('createLookup：区间边界两端都命中', () => {
  const lookup = createLookup(buildFixture());
  assert.deepEqual(lookup('10.0.0.0'), { province: 'Guangdong', provinceZh: '广东' });
  assert.deepEqual(lookup('10.255.255.255'), { province: 'Guangdong', provinceZh: '广东' });
  assert.deepEqual(lookup('91.127.255.255'), { province: 'Beijing', provinceZh: '北京' });
  assert.deepEqual(lookup('91.128.0.0'), { province: 'Guangdong', provinceZh: '广东' });
});

test('createLookup：未命中 / 非法 IP / IPv6 → null', () => {
  const lookup = createLookup(buildFixture());
  assert.equal(lookup('8.8.8.8'), null);
  assert.equal(lookup('not-an-ip'), null);
  assert.equal(lookup('2001:db8::1'), null);
  assert.equal(lookup(''), null);
  assert.equal(lookup(null), null);
});

test('真实数据文件：能加载且查到已知 IP（构建产物存在时才跑）', (t) => {
  if (!fs.existsSync(BIN)) {
    t.skip('china-geo.bin 未构建（先跑 node scripts/build-china-geo.mjs）');
    return;
  }
  const lookup = createLookup(fs.readFileSync(BIN));
  assert.deepEqual(lookup('114.114.114.114'), { province: 'Shandong', provinceZh: '山东' });
  assert.deepEqual(lookup('223.5.5.5'), { province: 'Zhejiang', provinceZh: '浙江' });
  assert.equal(lookup('8.8.8.8'), null);
});
