/**
 * 工程自检脚本：node tools/check.js
 * 不依赖任何 npm 包，也不启动子进程（避免沙箱管道限制）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const CLOUD = path.join(ROOT, 'cloudfunctions');

let pass = 0;
let fail = 0;
const problems = [];

function ok(msg) {
  pass += 1;
  console.log('  PASS  ' + msg);
}
function bad(msg) {
  fail += 1;
  problems.push(msg);
  console.log('  FAIL  ' + msg);
}

function walk(dir, filter, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') return;
      walk(full, filter, out);
    } else if (filter(e.name)) {
      out.push(full);
    }
  });
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------------- 1. JS 语法 ---------------- */
console.log('\n[1] JS 语法检查');
const jsFiles = walk(MINI, (n) => n.endsWith('.js'))
  .concat(walk(CLOUD, (n) => n.endsWith('.js')))
  .concat(walk(path.join(ROOT, 'tools'), (n) => n.endsWith('.js')));
jsFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.Script(src, { filename: f });
    ok('语法 OK  ' + rel(f));
  } catch (e) {
    bad('语法错误 ' + rel(f) + ' → ' + e.message);
  }
});

/* ---------------- 2. JSON 合法性 ---------------- */
console.log('\n[2] JSON 合法性');
// import/ 下是 JSON Lines（一行一条记录），不是单个 JSON 文档，
// 不能用 JSON.parse 整份解析——它由 [9] 专门校验，这里排除掉。
const jsonFiles = walk(ROOT, (n) => n.endsWith('.json') && n !== 'package-lock.json').filter(
  (f) => rel(f).indexOf('import/') !== 0
);
jsonFiles.forEach((f) => {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('JSON OK  ' + rel(f));
  } catch (e) {
    bad('JSON 错误 ' + rel(f) + ' → ' + e.message);
  }
});

/* ---------------- 3. app.json 页面文件齐全 ---------------- */
console.log('\n[3] app.json 声明的页面文件');
const appJson = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
appJson.pages.forEach((p) => {
  ['js', 'wxml', 'json', 'wxss'].forEach((ext) => {
    const f = path.join(MINI, p + '.' + ext);
    if (fs.existsSync(f)) ok('存在 ' + rel(f));
    else bad('缺少 ' + rel(f));
  });
});
(appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []).forEach((t) => {
  if (appJson.pages.indexOf(t.pagePath) < 0) bad('tabBar 页面未在 pages 中声明：' + t.pagePath);
  else ok('tabBar 页面已声明：' + t.pagePath);
});

/* ---------------- 4. WXML 标签平衡（粗检） ---------------- */
console.log('\n[4] WXML 标签平衡（粗检）');
const wxmlFiles = walk(MINI, (n) => n.endsWith('.wxml'));
wxmlFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const tags = ['view', 'block', 'scroll-view'];
  let broken = null;
  tags.forEach((t) => {
    const open = (src.match(new RegExp('<' + t + '(\\s|>)', 'g')) || []).length;
    const selfClose = (src.match(new RegExp('<' + t + '[^>]*/>', 'g')) || []).length;
    const close = (src.match(new RegExp('</' + t + '>', 'g')) || []).length;
    if (open - selfClose !== close) {
      broken = t + ' 开' + (open - selfClose) + ' / 闭' + close;
    }
  });
  if (broken) bad('标签不平衡 ' + rel(f) + ' → ' + broken);
  else ok('标签平衡 ' + rel(f));
});

/* ---------------- 5. 前后端 action 一致性 ---------------- */
console.log('\n[5] 前后端接口一致性');
const cloudSrc = fs.readFileSync(path.join(CLOUD, 'api', 'index.js'), 'utf8');
const declared = {};
(cloudSrc.match(/case '([a-zA-Z]+)':/g) || []).forEach((m) => {
  declared[m.replace(/case '|':/g, '')] = true;
});
const used = {};
walk(MINI, (n) => n.endsWith('.js')).forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const re = /api\s*\.\s*call\(\s*'([a-zA-Z]+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const a = m[1];
    used[a] = used[a] || [];
    used[a].push(rel(f));
  }
});
Object.keys(used).forEach((a) => {
  if (declared[a]) ok('接口存在：' + a + '  (' + used[a].length + ' 处调用)');
  else bad('前端调用了云函数里不存在的 action：' + a + ' ← ' + used[a].join(', '));
});
Object.keys(declared).forEach((a) => {
  if (!used[a]) console.log('  INFO  云函数提供了但前端未使用：' + a);
});

/* ---------------- 6. 种子数据 ---------------- */
console.log('\n[6] 菜库种子数据');
const seedPath = path.join(MINI, 'data', 'dishes.seed.js');
try {
  const seed = require(seedPath);
  if (!Array.isArray(seed)) bad('dishes.seed.js 不是数组');
  else ok('可 require，数量 = ' + seed.length);
  const keys = ['name', 'category', 'desc', 'emoji', 'limit', 'tags', 'sort', 'available'];
  const badItem = seed.find((d) => keys.some((k) => !(k in d)));
  if (badItem) bad('存在字段缺失的菜品：' + JSON.stringify(badItem));
  else ok('所有菜品字段齐全：' + keys.join('/'));
  const names = seed.map((d) => d.name);
  if (new Set(names).size !== names.length) bad('菜名有重复');
  else ok('菜名无重复');
  const on = seed.filter((d) => d.available).length;
  ok('默认上架 ' + on + ' 道 / 共 ' + seed.length + ' 道');
} catch (e) {
  bad('种子数据无法加载 → ' + e.message);
}

/* ---------------- 7. WXML / WXSS class 一致性 ---------------- */
console.log('\n[7] WXML / WXSS class 一致性');

function classesIn(css) {
  const out = new Set();
  const re = /\.(-?[A-Za-z_][\w-]*)/g;
  let m;
  while ((m = re.exec(css)) !== null) out.add(m[1]);
  return out;
}

const appWxssPath = path.join(MINI, 'app.wxss');
const appWxss = fs.readFileSync(appWxssPath, 'utf8');
const appClasses = classesIn(appWxss);

// 小程序 WXSS 不支持通用选择器 *
const wxssFiles = [[appWxssPath, appWxss]].concat(
  walk(MINI, (n) => n.endsWith('.wxss') && n !== 'app.wxss').map((f) => [f, fs.readFileSync(f, 'utf8')])
);
wxssFiles.forEach(([f, css]) => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/(^|[},;\s])\*\s*\{/.test(stripped)) bad('WXSS 使用了通用选择器 *（小程序不支持）：' + rel(f));
  else ok('无通用选择器 ' + rel(f));
});

wxmlFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const ownWxssPath = f.replace(/\.wxml$/, '.wxss');
  const ownClasses = fs.existsSync(ownWxssPath) ? classesIn(fs.readFileSync(ownWxssPath, 'utf8')) : new Set();
  const usable = new Set([...appClasses, ...ownClasses]);

  const used = new Set();
  const re = /(?:class|placeholder-class)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 去掉 {{...}} 动态部分，只校验字面量 class
    const literal = m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ');
    literal
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => used.add(c));
  }

  const missing = [...used].filter((c) => !usable.has(c));
  if (missing.length) bad('WXML 用到但没定义的 class：' + rel(f) + ' → ' + missing.join(', '));
  else ok('class 全部有定义 ' + rel(f) + '（用到 ' + used.size + ' 个）');
});

/* ---------------- 7.5 WXML 结构检查 ---------------- */
console.log('\n[7.5] wx:for 必须带 wx:key');

/**
 * 识别引号的标签扫描。
 * 不能简单用 /<input[^>]*>/ 这种正则——属性里可能有 {{item.qty > 0}} 这类含 > 的表达式，
 * 会把标签提前截断（这个坑真踩过：点菜页的备注输入框就这么被漏掉过）。
 * 规则：只有不在引号里的 > 才算标签结束。
 */
function scanTags(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const nm = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 40));
    if (!nm) {
      i = lt + 1;
      continue;
    }
    let j = lt + nm[0].length;
    let quote = null;
    for (; j < src.length; j += 1) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '>') break;
    }
    out.push({ name: nm[1], text: src.slice(lt, j + 1) });
    i = j + 1;
  }
  return out;
}

wxmlFiles.forEach((f) => {
  const tags = scanTags(fs.readFileSync(f, 'utf8'));
  const loops = tags.filter((t) => /wx:for\s*=/.test(t.text));
  const missing = loops.filter((t) => !/wx:key\s*=/.test(t.text)).map((t) => t.name);
  if (missing.length) {
    bad('wx:for 缺少 wx:key（会导致列表渲染复用错乱）：' + rel(f) + ' → ' + missing.join(', '));
  } else {
    ok('wx:for 都带了 wx:key ' + rel(f) + '（' + loops.length + ' 处）');
  }
});

console.log('\n[7.6] 按钮放在它真正影响的那一块下面');

/**
 * 「清空本场点赞」必须排在「累计榜（跨场次）」**前面**。
 *
 * 为什么值得写成检查：这个按钮只清**正在看的那一场**，而累计榜是跨场次加出来的。
 * 按钮排在累计榜底下时，主人会以为它连累计票一起清掉（真被这么问过：
 * 「清空本场点赞按钮在累计榜下面，是不是不太对」）。
 * 按钮位置属于"只有肉眼才看得出来的语义"，所以拿静态检查兜住。
 */
{
  const file = path.join(ROOT, 'miniprogram/pages/admin/dashboard/dashboard.wxml');
  const src = fs.readFileSync(file, 'utf8');
  const atBtn = src.indexOf('onResetVotes');
  const atAll = src.indexOf('累计榜（跨场次）');
  if (atBtn < 0) {
    bad('看板里找不到「清空点赞」按钮（onResetVotes）');
  } else if (atAll < 0) {
    bad('看板里找不到「累计榜（跨场次）」标题');
  } else if (atBtn > atAll) {
    bad('「清空本场点赞」排到了累计榜下面：它只清这一场，摆在跨场次的累计榜底下会被误解成"连累计票一起清"');
  } else {
    ok('「清空本场点赞」在本场榜里、累计榜之前（不会被误解成清累计票）');
  }
}

/* ---------------- 8. input 垂直对齐防护 ---------------- */console.log('\n[8] input 垂直对齐防护（原生组件不能用垂直 padding）');

// WXML 里所有 <input> 用到的 class（用上面的 scanTags，避免被 {{a > b}} 里的 > 截断）
const inputClasses = new Set();
wxmlFiles.forEach((f) => {
  scanTags(fs.readFileSync(f, 'utf8'))
    .filter((t) => t.name === 'input')
    .forEach((t) => {
      const cm = /class\s*=\s*"([^"]*)"/.exec(t.text);
      if (!cm) return;
      cm[1]
        .replace(/\{\{[\s\S]*?\}\}/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => inputClasses.add(c));
    });
});
console.log('  INFO  发现 ' + inputClasses.size + ' 个用在 <input> 上的 class：' + [...inputClasses].sort().join(', '));

// 所有 WXSS 规则块
const cssRules = [];
wxssFiles.forEach(([file, css]) => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) cssRules.push({ selector: m[1].trim(), body: m[2] });
});

// padding 简写/长写里是否出现非 0 的上下值
function badVerticalPadding(body) {
  const bad = [];
  (body.match(/padding\s*:[^;]*/g) || []).forEach((decl) => {
    const vals = decl.split(':')[1].trim().split(/\s+/);
    if (vals[0] !== '0' && vals[0] !== '0rpx') bad.push(decl.trim());
    if (vals.length >= 3 && vals[2] !== '0' && vals[2] !== '0rpx') bad.push(decl.trim());
  });
  (body.match(/padding-(top|bottom)\s*:[^;]*/g) || []).forEach((decl) => {
    const v = decl.split(':')[1].trim();
    if (v !== '0' && v !== '0rpx') bad.push(decl.trim());
  });
  return bad;
}

[...inputClasses].sort().forEach((cls) => {
  const hits = cssRules.filter((r) => new RegExp('\\.' + cls.replace(/-/g, '\\-') + '(?![\\w-])').test(r.selector));
  if (!hits.length) {
    bad('input 的 class 没有任何样式定义：.' + cls);
    return;
  }
  const merged = hits.map((h) => h.body).join(';');
  const hasHeight = /(^|[;\s])height\s*:/.test(merged);
  const badPad = badVerticalPadding(merged);

  if (!hasHeight) bad('input 缺少显式 height（小程序里文字会垂直错位）：.' + cls);
  else if (badPad.length) bad('input 上有垂直 padding（文字会掉到框下面）：.' + cls + ' → ' + badPad.join(' / '));
  else ok('input 防护 OK：.' + cls + '（有 height、无垂直 padding）');
});

/* ---------------- 9. 菜库菜单与导入文件一致性 ---------------- */
console.log('\n[9] 菜库菜单与导入文件');

const menuValidator = require('./validate-menu.js');
const SEED = require(path.join(MINI, 'data', 'dishes.seed.js'));

const menuProblems = menuValidator.validateMenu(SEED);
if (menuProblems.length) menuProblems.forEach((p) => bad('菜库数据：' + p));
else ok('菜库数据校验通过（' + SEED.length + ' 道：字段/长度/取值/分类内排序都合格）');

const importFile = path.join(ROOT, 'import', 'my-menu.json');
if (!fs.existsSync(importFile)) {
  console.log('  INFO  还没生成导入文件（运行 node tools/make-import.js 生成）');
} else {
  const imp = menuValidator.validateImportFile(SEED, importFile);
  if (imp.problems.length) imp.problems.forEach((p) => bad('导入文件：' + p));
  else {
    ok(
      '导入文件与菜库逐字一致（' + imp.stats.count + ' 条 / ' + imp.stats.categories + ' 个分类 / 默认上架 ' +
        imp.stats.onCount + ' 道 / 限量 ' + imp.stats.limited + ' 道）'
    );
  }
}

/* ---------------- 10. 结果 ---------------- */
console.log('\n[10] 结果');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n需要修复：');
  problems.forEach((p) => console.log('  - ' + p));
  process.exitCode = 1;
} else {
  console.log('  全部通过 ✅');
}
