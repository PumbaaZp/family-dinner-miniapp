/**
 * 从菜库种子生成「云开发控制台可直接导入」的文件。
 *
 *   node tools/make-import.js
 *
 * 产出（都在 import/ 目录下）：
 *   my-menu.json   JSON Lines，一行一条记录 —— 云开发控制台「导入」用这个
 *   my-menu.csv    CSV 备用 —— 有些控制台版本只认 CSV
 *
 * 为什么要生成而不是手写：字段名错一个（比如写成 title 而不是 name），
 * 导入不会报错，但朋友端菜名会是空白。生成能保证格式永远对。
 * 生成前先校验一遍，不合格直接失败，不给导入埋雷。
 */
const fs = require('fs');
const path = require('path');

const { validateMenu, toRecords, CATEGORY_ORDER, FIELDS } = require('./validate-menu.js');

const SEED = require('../miniprogram/data/dishes.seed.js');
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'import');

/* ---------------- 先校验，不合格就不产出 ---------------- */

const problems = validateMenu(SEED);
if (problems.length) {
  console.error('❌ 校验不通过，未生成文件：');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}

/* ---------------- 产出 ---------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
const records = toRecords(SEED);

// JSON Lines（云开发控制台「导入」用的格式：一行一条，不是 JSON 数组）
const jsonl = records.map((d) => JSON.stringify(d)).join('\n') + '\n';
fs.writeFileSync(path.join(OUT_DIR, 'my-menu.json'), jsonl, 'utf8');

// CSV 备用
const csvCell = (v) => '"' + String(v === null ? '' : v).replace(/"/g, '""') + '"';
const csvRows = [FIELDS.join(',')].concat(
  records.map((d) =>
    [
      csvCell(d.name),
      csvCell(d.category),
      csvCell(d.desc),
      csvCell(d.emoji),
      csvCell(d.limit === null ? '' : d.limit),
      csvCell(d.tags.join('|')),
      csvCell(d.sort),
      csvCell(d.available ? 'true' : 'false')
    ].join(',')
  )
);
fs.writeFileSync(path.join(OUT_DIR, 'my-menu.csv'), csvRows.join('\n') + '\n', 'utf8');

/* ---------------- 报告 ---------------- */

const byCat = {};
records.forEach((d) => {
  byCat[d.category] = (byCat[d.category] || 0) + 1;
});
const limited = records.filter((d) => d.limit !== null);
const onCount = records.filter((d) => d.available).length;

console.log('✅ 校验通过，已生成：');
console.log('   import/my-menu.json   （' + records.length + ' 条，JSON Lines，控制台导入用这个）');
console.log('   import/my-menu.csv    （CSV 备用）');
console.log('');
console.log('   分类分布：' + CATEGORY_ORDER.map((c) => c + ' ' + (byCat[c] || 0)).join(' / '));
console.log('   限量菜：  ' + (limited.length ? limited.map((d) => d.name + '（限 ' + d.limit + ' 份）').join('、') : '无'));
console.log('   默认上架：' + onCount + ' 道' + (onCount === 0 ? '（有意为之：库是"能做什么"，上架才是"今晚做什么"）' : ''));
