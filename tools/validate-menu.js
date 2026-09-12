/**
 * 菜库数据的单一校验来源。
 *
 *   validateMenu(seed)                 校验菜单数组本身是否合格
 *   validateImportFile(seed, file)     校验生成的导入文件与菜单是否一致
 *
 * 生成器（tools/make-import.js）和检查器（tools/check.js）共用这里，
 * 避免"两处规则各写一遍、改了一处忘了另一处"。
 */
const fs = require('fs');

const CATEGORY_ORDER = ['猪肉', '鸡肉', '蔬菜', '贝蟹虾', '鱼类', '主食', '汤羹', '甜品', '饮品', '快手菜'];
const FIELDS = ['name', 'category', 'desc', 'emoji', 'limit', 'tags', 'ingredients', 'sort', 'available'];
// 厨房必然常备的东西不该进买菜清单（精确匹配；糖不在内——甜品里它是主料）
const PANTRY = ['盐', '食盐', '食用油', '油', '水', '清水', '白开水', '味精', '鸡精'];

/** 校验菜单数组，返回问题列表（空数组 = 通过） */
function validateMenu(seed) {
  const problems = [];
  if (!Array.isArray(seed)) return ['种子数据不是数组'];
  if (!seed.length) return ['种子数据是空的'];

  const seenNames = new Set();

  seed.forEach((d, i) => {
    const where = '第 ' + (i + 1) + ' 条（' + (d && d.name) + '）';
    if (!d || typeof d !== 'object') {
      problems.push(where + ' 不是对象');
      return;
    }
    FIELDS.forEach((f) => {
      if (!(f in d)) problems.push(where + ' 缺少字段 ' + f);
    });
    if (!d.name || String(d.name).length > 30) problems.push(where + ' 菜名缺失或超过 30 字');
    if (seenNames.has(d.name)) problems.push(where + ' 菜名重复：' + d.name);
    seenNames.add(d.name);
    if (!d.category || String(d.category).length > 12) problems.push(where + ' 分类缺失或超过 12 字');
    if (!CATEGORY_ORDER.includes(d.category)) problems.push(where + ' 分类不在预期列表里：' + d.category);
    if (String(d.desc || '').length > 60) problems.push(where + ' 描述超过 60 字');
    if (!d.emoji || String(d.emoji).length > 8) problems.push(where + ' emoji 缺失或过长');
    if (d.limit !== null && (!Number.isInteger(d.limit) || d.limit < 1 || d.limit > 99)) {
      problems.push(where + ' limit 只能是 null 或 1-99 的整数');
    }
    if (!Array.isArray(d.tags) || d.tags.length > 5 || d.tags.some((t) => String(t).length > 10)) {
      problems.push(where + ' tags 必须是数组且不超过 5 个、每个不超过 10 字');
    }
    // 食材：买菜清单的来源，必须每道菜都有
    if (!Array.isArray(d.ingredients) || !d.ingredients.length) {
      problems.push(where + ' ingredients 必须是非空数组（买菜清单靠它）');
    } else {
      if (d.ingredients.length > 10) problems.push(where + ' 食材超过 10 项，清单会太长');
      const seenIng = new Set();
      d.ingredients.forEach((ing) => {
        const s = String(ing);
        if (!s.trim()) problems.push(where + ' 有空的食材名');
        if (s.length > 12) problems.push(where + ' 食材名过长：' + s);
        if (seenIng.has(s)) problems.push(where + ' 食材重复：' + s);
        seenIng.add(s);
        if (PANTRY.includes(s)) problems.push(where + ' 食材是厨房常备的（不该进买菜清单）：' + s);
      });
    }
    if (!Number.isInteger(d.sort) || d.sort < 0) problems.push(where + ' sort 必须是非负整数');
    if (typeof d.available !== 'boolean') problems.push(where + ' available 必须是布尔值');
  });

  CATEGORY_ORDER.forEach((cat) => {
    const sorts = seed.filter((d) => d.category === cat).map((d) => d.sort);
    for (let i = 1; i < sorts.length; i += 1) {
      if (sorts[i] <= sorts[i - 1]) {
        problems.push('分类「' + cat + '」内 sort 不是递增的：' + sorts.join(', '));
        break;
      }
    }
  });

  return problems;
}

/** 菜单数组 → 要写进导入文件的对象（字段顺序固定，便于比对） */
function toRecords(seed) {
  return seed.map((d) => ({
    name: d.name,
    category: d.category,
    desc: d.desc,
    emoji: d.emoji,
    limit: d.limit,
    tags: d.tags,
    ingredients: d.ingredients,
    sort: d.sort,
    available: d.available
  }));
}

/** 校验导入文件：编码、逐行 JSON、字段、以及与菜单是否逐字一致 */
function validateImportFile(seed, file) {
  const problems = [];
  if (!fs.existsSync(file)) return { problems: ['导入文件不存在：' + file], stats: null };

  const buf = fs.readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push('导入文件带 UTF-8 BOM，控制台可能解析失败');
  }
  const text = buf.toString('utf8');

  const lines = text.trim().split('\n');
  const records = [];
  lines.forEach((line, i) => {
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      problems.push('第 ' + (i + 1) + ' 行不是合法 JSON：' + line.slice(0, 40) + '…');
    }
  });

  const badFields = records.filter((r) => FIELDS.some((f) => !(f in r)));
  if (badFields.length) problems.push('有 ' + badFields.length + ' 条记录字段不齐');

  const names = records.map((r) => r.name);
  if (new Set(names).size !== names.length) problems.push('导入文件里有重复菜名');

  const expected = JSON.stringify(toRecords(seed));
  const actual = JSON.stringify(records);
  if (expected !== actual) {
    problems.push('导入文件与菜库种子不一致（先跑 node tools/make-import.js 重新生成）');
  }

  return {
    problems,
    stats: {
      count: records.length,
      categories: CATEGORY_ORDER.filter((c) => records.some((r) => r.category === c)).length,
      onCount: records.filter((r) => r.available).length,
      limited: records.filter((r) => r.limit !== null).length
    }
  };
}

module.exports = { validateMenu, validateImportFile, toRecords, CATEGORY_ORDER, FIELDS };
