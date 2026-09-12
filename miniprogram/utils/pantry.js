/**
 * 库存（家里有什么）相关的纯逻辑
 *
 * 全部是不依赖 wx 的纯函数：既给页面用，也能在 node 里直接测。
 */

/** 分类顺序：录入、分组、筛选都按这个顺序 */
const CATS = ['食材', '调料', '其他'];

/**
 * 明显是调料的词 —— 只在"从菜谱食材快速添加"时用来自动分类，
 * 分错了在库存页改一下就行，所以宁可少判也不乱判。
 *
 * 单字的词只做全等匹配（"油" 只匹配名字正好是"油"的），
 * 避免把"油麦菜""盐焗鸡"这类也吞进来；多字的才用包含匹配（"生抽" 命中"薄盐生抽"）。
 */
const SEASONINGS = [
  '盐', '油', '醋', '糖',
  '生抽', '老抽', '酱油', '香醋', '白醋', '陈醋', '米醋',
  '料酒', '黄酒', '蚝油', '蒸鱼豉油', '鱼露',
  '冰糖', '白糖', '红糖', '砂糖', '蜂蜜',
  '味精', '鸡精', '鸡粉', '胡椒粉', '白胡椒', '黑胡椒',
  '花椒', '干辣椒', '小米椒', '泡椒', '辣椒面', '辣椒油',
  '豆瓣酱', '甜面酱', '黄豆酱', '番茄酱', '芝麻酱', '沙茶酱',
  '淀粉', '生粉', '食用油', '香油', '芝麻油', '橄榄油',
  '八角', '桂皮', '香叶', '孜然', '五香粉', '十三香', '咖喱',
  '白芝麻', '黑芝麻', '酵母'
];

/** 猜一个分类（默认「食材」，宁可回落到最常用的那类） */
function guessCat(name) {
  const n = String(name || '').trim();
  if (!n) return '食材';
  for (let i = 0; i < SEASONINGS.length; i += 1) {
    const k = SEASONINGS[i];
    if (k.length === 1 ? n === k : n.indexOf(k) >= 0) return '调料';
  }
  return '食材';
}

function normalizeCat(cat) {
  const c = String(cat || '').trim();
  return CATS.indexOf(c) >= 0 ? c : '食材';
}

/**
 * 解析批量粘贴的文本，一行一条：
 *   生抽 2瓶        → { name: '生抽', qty: '2瓶' }
 *   五花肉，1斤      → { name: '五花肉', qty: '1斤' }
 *   - 小葱
 *   1. 生姜
 *   # 这行会被忽略
 * 名称取第一个字段，剩下的都当"数量/备注"拼起来；同名只留第一条。
 */
function parseBulk(text) {
  const out = [];
  const seen = {};
  String(text || '')
    .split(/\r?\n/)
    .forEach((raw) => {
      let line = String(raw).replace(/^\s*[-*·•]\s*/, '');
      line = line.replace(/^\d+\s*[.、)）]\s*/, '').trim();
      if (!line || line.charAt(0) === '#') return;

      const parts = line.split(/[\s,，、;；|/]+/).filter(Boolean);
      if (!parts.length) return;
      const name = parts[0].slice(0, 20);
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push({ name: name, qty: parts.slice(1).join(' ').slice(0, 12), cat: guessCat(name) });
    });
  return out;
}

/** 排序：食材 → 调料 → 其他，同类按名字（跟云函数返回的顺序保持一致） */
function sortItems(items) {
  return (items || []).slice().sort((a, b) => {
    const ca = CATS.indexOf(normalizeCat(a.cat));
    const cb = CATS.indexOf(normalizeCat(b.cat));
    if (ca !== cb) return ca - cb;
    return String(a.name).localeCompare(String(b.name));
  });
}

/** 库存数组 → [{ cat, count, items }]，空分类不出现 */
function groupItems(items) {
  const map = {};
  sortItems(items).forEach((it) => {
    const cat = normalizeCat(it.cat);
    if (!map[cat]) map[cat] = [];
    map[cat].push(it);
  });
  return CATS.filter((c) => map[c] && map[c].length).map((c) => ({
    cat: c,
    count: map[c].length,
    items: map[c]
  }));
}

/** 库存数组 → { 名称: true }，用来快速判断"家里有没有" */
function toNameMap(items) {
  const m = {};
  (items || []).forEach((it) => {
    if (it && it.name) m[it.name] = true;
  });
  return m;
}

/**
 * 一道菜的食材里，家里已经有了几样
 * 只做同名匹配（跟采购清单同一套口径），"小葱"和"葱"会被当成两样——这是有意的：
 * 宁可多算一样缺的，也别自作聪明把不一样的当成一样的。
 */
function coverage(dish, haveMap) {
  const ing = ((dish && dish.ingredients) || []).filter(Boolean);
  const have = ing.filter((n) => haveMap && haveMap[n]);
  const missing = ing.filter((n) => !haveMap || !haveMap[n]);
  return {
    total: ing.length,
    haveCount: have.length,
    missing: missing,
    full: ing.length > 0 && missing.length === 0
  };
}

/** 菜单页那一行的短提示 */
function coverageShort(cov) {
  if (!cov || !cov.total) return '';
  if (cov.full) return '食材都有';
  return '缺 ' + cov.missing.length + ' 样';
}

/** 点开看的详细提示（缺哪几样） */
function coverageDetail(name, cov) {
  if (!cov || !cov.total) return '「' + name + '」还没配食材。\n\n可以去「家宴设置与菜库」点一下「补全食材」。';
  if (cov.full) return '「' + name + '」要用的 ' + cov.total + ' 样家里都有：' + cov.haveCount + '/' + cov.total + '。';
  return (
    '「' + name + '」要用 ' + cov.total + ' 样，家里有 ' + cov.haveCount + ' 样。\n\n还缺：' + cov.missing.join('、')
  );
}

module.exports = {
  CATS: CATS,
  SEASONINGS: SEASONINGS,
  guessCat: guessCat,
  normalizeCat: normalizeCat,
  parseBulk: parseBulk,
  sortItems: sortItems,
  groupItems: groupItems,
  toNameMap: toNameMap,
  coverage: coverage,
  coverageShort: coverageShort,
  coverageDetail: coverageDetail
};
