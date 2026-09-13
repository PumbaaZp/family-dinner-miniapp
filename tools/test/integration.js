/**
 * 离线集成测试：node tools/test/integration.js
 *
 * 两件事：
 *  A. 用本地 mock 的 wx-server-sdk 真跑云函数，走完整业务流程
 *     （初始化 → 导菜 → 上下架 → 限量 → 下单 → 改单 → 汇总 → 截止 → 撤单）
 *  B. 在 mock 的 wx/Page 环境下加载 4 个页面，并直接验证前端纯逻辑
 *     （购物车计算、点单明细、看板复制文本、分组统计）
 *
 * 退出码非 0 表示有失败项。
 */
const path = require('path');
const Module = require('module');

const { createMockCloud, createState } = require('./mock-wx-server-sdk.js');

const ROOT = path.resolve(__dirname, '..', '..');
const state = createState();

// 拦截 wx-server-sdk
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return createMockCloud(state);
  return originalLoad.apply(this, arguments);
};

const cloudApi = require(path.join(ROOT, 'cloudfunctions', 'api', 'index.js'));
const SEED = require(path.join(ROOT, 'miniprogram', 'data', 'dishes.seed.js'));

/* ------------------------- 断言工具 ------------------------- */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra) {
  pass += 1;
  console.log('  PASS  ' + name + (extra ? '  → ' + extra : ''));
}

function bad(name, extra) {
  fail += 1;
  failures.push(name + (extra ? ' → ' + extra : ''));
  console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
}

function expect(name, cond, extra) {
  if (cond) ok(name, extra);
  else bad(name, extra);
}

/* ------------------------- 场景 ------------------------- */

const HOST = 'openid_host';
const WIFE = 'openid_wife';
const GUEST_B = 'openid_guest_b';
const GUEST_C = 'openid_guest_c';

async function call(action, data, openid) {
  state.openid = openid || HOST;
  return cloudApi.main(Object.assign({ action: action }, data || {}));
}

async function runBackend() {
  console.log('\n[A] 云函数端到端');

  /* --- 初始化 --- */
  let r = await call('whoami', {}, GUEST_B);
  expect('未初始化时 whoami → inited=false', r.ok && r.data.inited === false);
  expect('未初始化时 config 为空', r.ok && r.data.config === null);

  r = await call('init', {}, HOST);
  expect('主人 init → isAdmin=true', r.ok && r.data.isAdmin === true);
  const hostCode = r.ok && r.data.config ? r.data.config.hostCode : '';
  expect('init 自动生成 4 位主人口令', /^\d{4}$/.test(String(hostCode)), '口令=' + hostCode);
  expect('init 自动建了 4 个集合', Object.keys(state.collections).sort().join(',') === 'config,dishes,orders,votes',
    '实际=' + Object.keys(state.collections).sort().join(','));

  r = await call('whoami', {}, GUEST_B);
  expect('朋友 whoami → inited=true / isAdmin=false', r.ok && r.data.inited === true && r.data.isAdmin === false);
  expect('朋友看不到主人口令', r.ok && r.data.config && r.data.config.hostCode === undefined);

  r = await call('init', { hostCode: '0000' }, GUEST_C);
  expect('错误口令 init 被拒绝', r.ok === false, r.msg);
  r = await call('init', { hostCode: hostCode }, WIFE);
  expect('正确口令 init → 成为第二个主人', r.ok && r.data.isAdmin === true);

  /* --- 空菜库 --- */
  r = await call('listDishes', {}, GUEST_B);
  expect('空菜库时 listDishes 返回空数组', r.ok && Array.isArray(r.data.dishes) && r.data.dishes.length === 0);

  /* --- 导入菜库 --- */
  r = await call('seedDishes', { dishes: SEED }, GUEST_C);
  expect('非管理员不能导入菜库', r.ok === false, r.msg);

  r = await call('seedDishes', { dishes: SEED }, HOST);
  expect('导入内置菜库 → 新增 ' + SEED.length + ' 道', r.ok && r.data.added === SEED.length, JSON.stringify(r.data));

  r = await call('seedDishes', { dishes: SEED }, HOST);
  expect('重复导入不产生重复数据', r.ok && r.data.added === 0, JSON.stringify(r.data));

  /* 只补食材：不能动上架状态与限量（老菜库升级用） */
  await call('toggleDish', { id: (await call('listDishes', { all: true }, HOST)).data.dishes[0]._id, available: true }, HOST);
  const beforeFill = (await call('listDishes', { all: true }, HOST)).data.dishes;
  const sample = beforeFill.filter((d) => d.available)[0];
  await call('updateDish', { id: sample._id, patch: { limit: 7 } }, HOST);
  r = await call('seedDishes', { dishes: SEED, ingredientsOnly: true }, HOST);
  expect('「补全食材」会报告补了多少道', r.ok && r.data.ingredientsFilled > 0, JSON.stringify(r.data));
  const afterFill = (await call('listDishes', { all: true }, HOST)).data.dishes;
  const same = afterFill.filter((d) => d._id === sample._id)[0];
  expect('补全食材不动上架状态', same.available === true, JSON.stringify({ available: same.available }));
  expect('补全食材不动限量', same.limit === 7, 'limit=' + same.limit);
  expect('补全食材确实写进去了', Array.isArray(same.ingredients) && same.ingredients.length > 0, JSON.stringify(same.ingredients));
  await call('updateDish', { id: sample._id, patch: { limit: null } }, HOST);
  await call('batchToggle', { available: false }, HOST);

  r = await call('listDishes', {}, GUEST_B);
  expect('刚导入时朋友端看不到菜（菜库默认全部下架，等主人勾今晚的）', r.data.dishes.length === 0, '实际=' + r.data.dishes.length);

  r = await call('listDishes', { all: true }, HOST);
  expect('主人端 all=true 看到全部 ' + SEED.length + ' 道', r.data.dishes.length === SEED.length, '实际=' + r.data.dishes.length);
  r = await call('listDishes', { all: true }, GUEST_B);
  expect('朋友传 all=true 也拿不到未上架的菜', r.data.dishes.length === 0, '实际=' + r.data.dishes.length);

  /* --- 上下架 --- */
  r = await call('batchToggle', { available: true }, HOST);
  expect('全部上架 → 更新 ' + SEED.length + ' 道', r.ok && r.data.updated === SEED.length, JSON.stringify(r.data));

  r = await call('listDishes', {}, GUEST_B);
  const visible = r.data.dishes;
  expect('全部上架后朋友端看到 ' + SEED.length + ' 道', visible.length === SEED.length, '实际=' + visible.length);
  expect('朋友端菜品不含 _openid 字段', visible.every((d) => d._openid === undefined));
  expect('朋友端菜品按 sort 升序', visible.every((d, i) => i === 0 || visible[i - 1].sort <= d.sort));

  r = await call('batchToggle', { available: false }, HOST);
  expect('全部下架 → 更新 ' + SEED.length + ' 道', r.ok && r.data.updated === SEED.length, JSON.stringify(r.data));
  r = await call('listDishes', {}, GUEST_B);
  expect('全部下架后朋友端菜单为空', r.data.dishes.length === 0);

  // 后面的下单测试需要菜是上架的，恢复回来
  await call('batchToggle', { available: true }, HOST);

  r = await call('toggleDish', { id: 'nope', available: true }, GUEST_C);
  expect('非管理员不能上下架', r.ok === false, r.msg);

  /* --- 食材采购（依赖"菜已上架"） --- */
  r = await call('summary', {}, GUEST_C);
  expect('朋友看不到食材采购清单', r.ok === false && /权限/.test(r.msg), r.msg);

  r = await call('summary', {}, HOST);
  let shop = r.data.ingredients;
  expect('汇总带出食材清单（按上架菜单聚合）', Array.isArray(shop) && shop.length > 0, '食材数=' + (shop && shop.length));
  expect('每项食材都带"涉及哪些菜"和采购状态',
    shop.every((i) => i.name && Array.isArray(i.dishes) && typeof i.purchased === 'boolean'),
    JSON.stringify(shop[0]));
  expect('食材统计字段正确',
    r.data.ingredientStats.total === shop.length && r.data.ingredientStats.missing === shop.length && r.data.ingredientStats.purchased === 0,
    JSON.stringify(r.data.ingredientStats));
  expect('汇总里每道菜也带了自己的食材（导出"菜+食材"要用）',
    r.data.dishTotals.every((t) => Array.isArray(t.ingredients)),
    JSON.stringify(r.data.dishTotals[0] && r.data.dishTotals[0].ingredients));

  const ing0 = shop[0].name;
  r = await call('toggleIngredient', { name: ing0, purchased: true }, GUEST_C);
  expect('非管理员不能勾选采购', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('toggleIngredient', { purchased: true }, HOST);
  expect('缺食材名会被拒绝', r.ok === false && /食材/.test(r.msg), r.msg);

  r = await call('toggleIngredient', { name: ing0, purchased: true }, HOST);
  expect('勾选已采购成功', r.ok && r.data.purchased === true, JSON.stringify(r.data));
  r = await call('summary', {}, HOST);
  const after = r.data.ingredients.filter((i) => i.name === ing0)[0];
  expect('采购状态被保存下来', !!after && after.purchased === true, JSON.stringify(after));
  expect('已采购的统计正确',
    r.data.ingredientStats.purchased === 1 && r.data.ingredientStats.missing === r.data.ingredientStats.total - 1,
    JSON.stringify(r.data.ingredientStats));
  expect('已采购的排到清单最后（买菜先看缺的）',
    r.data.ingredients[r.data.ingredients.length - 1].name === ing0,
    r.data.ingredients.map((i) => i.name + (i.purchased ? '(已购)' : '')).slice(-3).join(','));

  r = await call('toggleIngredient', { name: ing0, purchased: false }, HOST);
  expect('取消勾选成功', r.ok && r.data.purchased === false, JSON.stringify(r.data));
  r = await call('toggleIngredient', { name: ing0, purchased: true }, HOST);
  r = await call('resetShopping', {}, GUEST_C);
  expect('非管理员不能清空勾选', r.ok === false, r.msg);
  r = await call('resetShopping', {}, HOST);
  expect('清空采购勾选', r.ok && r.data.cleared === 1, JSON.stringify(r.data));
  r = await call('summary', {}, HOST);
  expect('清空后没有已采购项', r.data.ingredientStats.purchased === 0, JSON.stringify(r.data.ingredientStats));

  /* --- 家里的库存（跟菜谱解耦：记的是"我家有什么"） --- */
  const ingTotal = r.data.ingredientStats.total;

  r = await call('listPantry', {}, GUEST_C);
  expect('朋友看不到家里的库存', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('savePantryItems', { name: '生抽' }, GUEST_C);
  expect('朋友不能改库存', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('whoami', {}, GUEST_B);
  expect('库存不会跟着配置发给朋友', r.ok && r.data.config && r.data.config.pantry === undefined, JSON.stringify(r.data.config));

  r = await call('listPantry', {}, HOST);
  expect('初始库存为空', r.ok && r.data.items.length === 0 && r.data.stats.total === 0, JSON.stringify(r.data.stats));

  r = await call('savePantryItems', { name: ing0, cat: '调料', qty: '2 瓶', note: '灶台下柜子' }, HOST);
  expect('第一次保存是「新增」', r.ok && r.data.added === 1 && r.data.updated === 0 && r.data.total === 1, JSON.stringify(r.data));
  r = await call('savePantryItems', { name: ing0, cat: '调料', qty: '3 瓶' }, HOST);
  expect('同名再保存是「更新」，不会变成两条', r.ok && r.data.updated === 1 && r.data.total === 1, JSON.stringify(r.data));
  r = await call('listPantry', {}, HOST);
  const afterPartial = r.data.items.filter((i) => i.name === ing0)[0];
  expect('更新时没传的字段保持不变（只改数量不该把备注抹掉）',
    afterPartial.qty === '3 瓶' && afterPartial.note === '灶台下柜子',
    JSON.stringify(afterPartial));
  r = await call('savePantryItems', { name: ing0, note: '' }, HOST);
  expect('显式传空字符串才是清空', r.ok && r.data.updated === 1);
  r = await call('listPantry', {}, HOST);
  const cleared = r.data.items.filter((i) => i.name === ing0)[0];
  expect('备注被清空、数量还在（只传了 note）',
    cleared.note === '' && cleared.qty === '3 瓶' && cleared.cat === '调料',
    JSON.stringify(cleared));
  await call('savePantryItems', { name: ing0, cat: '调料', qty: '3 瓶', note: '灶台下柜子' }, HOST);

  r = await call('savePantryItems', { items: [{ name: '咖啡豆', qty: '1 袋' }, { name: '   ' }, { name: '燕麦', cat: '不存在的分类' }] }, HOST);
  expect('批量保存会跳过空名称', r.ok && r.data.saved === 2 && r.data.added === 2, JSON.stringify(r.data));

  await call('savePantryItems', { name: '咖啡豆' }, HOST);
  r = await call('listPantry', {}, HOST);
  const coffee = r.data.items.filter((i) => i.name === '咖啡豆')[0];
  expect('「快速点选」只带名字，不会把已有条目的数量清掉', coffee.qty === '1 袋' && coffee.cat === '食材', JSON.stringify(coffee));

  r = await call('savePantryItems', { items: [{ name: '  ' }] }, HOST);
  expect('整批都是空名称时报错而不是静默成功', r.ok === false && /名称/.test(r.msg), r.msg);

  r = await call('listPantry', {}, HOST);
  const pantry = r.data.items;
  expect('库存按 食材 → 调料 → 其他 排序', pantry.map((i) => i.cat).join(',') === '食材,食材,调料', JSON.stringify(pantry.map((i) => i.name + '/' + i.cat)));
  expect('没填分类的默认「食材」', pantry.filter((i) => i.name === '咖啡豆')[0].cat === '食材');
  expect('不认识的分类回落到「食材」', pantry.filter((i) => i.name === '燕麦')[0].cat === '食材');
  expect('数量和备注原样存下来', pantry.filter((i) => i.name === ing0)[0].qty === '3 瓶' && pantry.filter((i) => i.name === ing0)[0].note === '灶台下柜子',
    JSON.stringify(pantry.filter((i) => i.name === ing0)));
  expect('库存统计按分类给数', r.data.stats.total === 3 && r.data.stats.food === 2 && r.data.stats.seasoning === 1, JSON.stringify(r.data.stats));

  r = await call('summary', {}, HOST);
  const stocked = r.data.ingredients.filter((i) => i.inStock);
  expect('汇总里每项食材都带「家里有没有」', r.data.ingredients.every((i) => typeof i.inStock === 'boolean'), JSON.stringify(r.data.ingredients[0]));
  expect('家里有的食材被标出来（' + ing0 + '）', stocked.length === 1 && stocked[0].name === ing0, JSON.stringify(stocked.map((i) => i.name)));
  expect('库存不会把食材从清单里删掉', r.data.ingredientStats.total === ingTotal, JSON.stringify(r.data.ingredientStats));
  expect('家里有的不算「还要买」',
    r.data.ingredientStats.missing === ingTotal - 1 && r.data.ingredientStats.inStock === 1,
    JSON.stringify(r.data.ingredientStats));
  expect('三个数加起来正好是总数',
    r.data.ingredientStats.inStock + r.data.ingredientStats.purchased + r.data.ingredientStats.missing === r.data.ingredientStats.total,
    JSON.stringify(r.data.ingredientStats));
  expect('家里有的排到清单最后（要买的先看）',
    r.data.ingredients[r.data.ingredients.length - 1].name === ing0,
    r.data.ingredients.map((i) => i.name + (i.inStock ? '(家里有)' : '')).slice(-3).join(','));
  expect('汇总把库存整份带回来（主人端要显示项数）',
    Array.isArray(r.data.pantry) && r.data.pantry.length === 3 && r.data.ingredientStats.pantryCount === 3,
    JSON.stringify(r.data.pantry));

  r = await call('removePantryItem', { name: '咖啡豆' }, HOST);
  expect('删掉一条库存', r.ok && r.data.removed === true && r.data.total === 2, JSON.stringify(r.data));
  r = await call('removePantryItem', { name: '不存在的' }, HOST);
  expect('删不存在的条目不报错', r.ok && r.data.removed === false && r.data.total === 2, JSON.stringify(r.data));
  r = await call('removePantryItem', {}, HOST);
  expect('缺名称会被拒绝', r.ok === false && /名称/.test(r.msg), r.msg);

  r = await call('clearPantry', {}, GUEST_C);
  expect('朋友不能清空库存', r.ok === false, r.msg);
  r = await call('clearPantry', {}, HOST);
  expect('清空库存返回清了多少条', r.ok && r.data.cleared === 2, JSON.stringify(r.data));
  r = await call('summary', {}, HOST);
  expect('清空后食材清单回到"全都要买"', r.data.ingredientStats.inStock === 0 && r.data.ingredientStats.missing === ingTotal,
    JSON.stringify(r.data.ingredientStats));

  /* --- 点赞：吃完给今晚的菜投票（每人最多 3 道） --- */
  expect('init 会把 votes 集合一起建好', Object.keys(state.collections).indexOf('votes') >= 0,
    Object.keys(state.collections).join(','));

  const menuAll = (await call('listDishes', { all: true }, HOST)).data.dishes;
  const onMenu = menuAll.filter((d) => d.available);
  const pick3 = [onMenu[0]._id, onMenu[1]._id, onMenu[2]._id];

  // 候选名单是"今晚点过的菜 ∪ 上架的菜"，所以先把点过的这件事造出来。
  // 用临时 openid 下单，块末尾撤销——不影响后面真正下单那些测试。
  const TMP_VOTER = 'openid_tmp_voter';
  await call('submitOrder', {
    nick: '临时投票客',
    partySize: 1,
    items: [{ dishId: pick3[0], qty: 2 }, { dishId: pick3[1], qty: 1 }]
  }, TMP_VOTER);

  r = await call('votes', {}, GUEST_B);
  expect('还没人投票时 totals 为空、voterCount 为 0', r.ok && r.data.totals.length === 0 && r.data.voterCount === 0, JSON.stringify(r.data.totals));
  expect('点赞上限是 3 道', r.ok && r.data.maxVotes === 3, 'maxVotes=' + (r.ok && r.data.maxVotes));
  expect('候选名单里有点过的菜（带份数）',
    r.data.candidates.length > 0 && r.data.candidates.every((c) => c.dishId && c.name && typeof c.likeCount === 'number'),
    JSON.stringify(r.data.candidates.slice(0, 2)));
  expect('候选名单：点过的排在前面（按份数）',
    r.data.candidates.filter((c) => c.ordered).length === 2 &&
      r.data.candidates[0].dishId === pick3[0] && r.data.candidates[0].qty === 2,
    JSON.stringify(r.data.candidates.slice(0, 3).map((c) => c.name + '×' + c.qty)));

  r = await call('submitVotes', { dishIds: [pick3[0], pick3[1], pick3[2], pick3[0], 'nope'] }, GUEST_B);
  expect('投票会去重、并忽略不存在的菜',
    r.ok && r.data.count === 3 && r.data.dishIds.join(',') === pick3.join(','),
    JSON.stringify(r.data));

  r = await call('submitVotes', { dishIds: [pick3[0], pick3[1], pick3[2], onMenu[3]._id] }, GUEST_B);
  expect('超过 3 道会被拒绝（不能偷偷多投）', r.ok === false && /最多/.test(r.msg), r.msg);

  r = await call('votes', {}, GUEST_B);
  expect('我投了哪些会回填出来（用于勾选状态）', r.data.myVotes.join(',') === pick3.join(','), JSON.stringify(r.data.myVotes));
  expect('合计里只统计一次（同一道菜不会因重复提交翻倍）',
    r.data.totals.length === 3 && r.data.totals.every((t) => t.count === 1),
    JSON.stringify(r.data.totals.map((t) => t.name + ':' + t.count)));

  r = await call('submitVotes', { dishIds: [pick3[0]] }, GUEST_B);
  expect('重新提交是覆盖，不是累加', r.ok && r.data.count === 1, JSON.stringify(r.data));
  r = await call('votes', {}, GUEST_B);
  expect('覆盖后只剩 1 票', r.data.myVotes.length === 1 && r.data.totals.length === 1, JSON.stringify(r.data.totals));

  await call('submitVotes', { dishIds: pick3 }, GUEST_B);
  await call('submitVotes', { dishIds: [pick3[0], pick3[1]] }, GUEST_C);
  r = await call('votes', {}, HOST);
  expect('多人投票会累加（老王 3 票 + 小李 2 票 → 头名 2 人）',
    r.data.voterCount === 2 && r.data.totals[0].count === 2 && r.data.totals[0].dishId === pick3[0],
    JSON.stringify(r.data.totals.map((t) => t.name + ':' + t.count)));

  r = await call('summary', {}, HOST);
  expect('看板汇总带出点赞榜', r.ok && r.data.likes.length === 3 && r.data.likeStats.voters === 2, JSON.stringify(r.data.likeStats));
  expect('菜品汇总每行带 likeCount（没被赞的是 0，不是 undefined）',
    r.data.dishTotals.every((t) => typeof t.likeCount === 'number') &&
      r.data.dishTotals.filter((t) => t.likeCount === 2).length === 2,
    JSON.stringify(r.data.dishTotals.map((t) => t.name + ':' + t.likeCount)));

  r = await call('board', {}, GUEST_C);
  expect('朋友端也能看到点赞数（"老朋友推荐什么"）', r.ok && r.data.likes.length === 3 && r.data.voterCount === 2, JSON.stringify(r.data.likeStats || r.data.voterCount));
  expect('朋友端的 feed 里不带别人的 openid',
    JSON.stringify(r.data.likes).indexOf('openid') < 0 && JSON.stringify(r.data.dishTotals).indexOf('openid') < 0);

  /* 下架之后照样能投票：家宴一结束主人常把菜全下架，而那时才是投票高峰 */
  await call('batchToggle', { available: false }, HOST);
  r = await call('submitVotes', { dishIds: [pick3[0]] }, GUEST_C);
  expect('菜全部下架后仍然能点赞（吃完才投票）', r.ok === true, r.msg);
  r = await call('votes', {}, GUEST_C);
  expect('下架后候选名单还在（来自订单，不会因下架而消失）',
    r.data.candidates.length > 0 && r.data.candidates.filter((c) => c.dishId === pick3[0]).length === 1,
    '候选数=' + r.data.candidates.length);
  await call('batchToggle', { available: true }, HOST);

  r = await call('submitVotes', { dishIds: [] }, GUEST_C);
  expect('传空数组 = 撤销我的赞（幂等，不报错）', r.ok && r.data.cleared === true && r.data.count === 0, JSON.stringify(r.data));
  r = await call('submitVotes', { dishIds: [] }, GUEST_C);
  expect('没有赞的时候再撤一次也不报错', r.ok === true && r.data.cleared === true, JSON.stringify(r.data));
  r = await call('votes', {}, HOST);
  expect('撤销后那个人从合计里消失（剩下的人各 1 票）',
    r.data.voterCount === 1 && r.data.totals.length === 3 && r.data.totals.every((t) => t.count === 1),
    JSON.stringify(r.data.totals.map((t) => t.name + ':' + t.count)));

  r = await call('resetVotes', {}, GUEST_C);
  expect('非管理员不能清空点赞', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('resetVotes', {}, HOST);
  expect('主人清空点赞返回清了几个人', r.ok && r.data.cleared === 1, JSON.stringify(r.data));
  r = await call('votes', {}, HOST);
  expect('清空后点赞归零', r.data.voterCount === 0 && r.data.totals.length === 0, JSON.stringify(r.data.totals));

  /* 老环境没建过 votes 集合时，第一次点赞要能自动补建（不能直接报 collection not exists） */
  delete state.collections.votes;
  r = await call('submitVotes', { dishIds: [pick3[0]] }, GUEST_B);
  expect('votes 集合不存在时自动补建并写入成功', r.ok === true && r.data.count === 1, r.msg);
  expect('补建之后集合真的有了', Array.isArray(state.collections.votes) && state.collections.votes.length === 1,
    JSON.stringify((state.collections.votes || []).length));
  r = await call('votes', {}, HOST);
  expect('补建后能正常读到', r.ok && r.data.voterCount === 1, JSON.stringify(r.data.totals));
  await call('resetVotes', {}, HOST);

  /* 投票不写进 config：朋友不该从配置里看到别人的投票 */
  r = await call('whoami', {}, GUEST_B);
  expect('配置里没有 votes/voterCount 这类内部字段',
    r.data.config && r.data.config.votes === undefined && r.data.config.voterCount === undefined,
    JSON.stringify(Object.keys(r.data.config || {})));

  /* 撤掉临时投票客的订单，把状态还原给后面的下单测试 */
  await call('cancelOrder', {}, TMP_VOTER);
  r = await call('summary', {}, HOST);
  expect('投票测试用的临时订单已撤销（不影响后面的流程）', r.data.stats.orderCount === 0,
    JSON.stringify(r.data.stats));

  /* 限量：自己设一个，不依赖种子数据里恰好有没有限量菜 */
  const allDishes = (await call('listDishes', { all: true }, HOST)).data.dishes;
  const water = allDishes.find((d) => d.limit === null);
  r = await call('updateDish', { id: water._id, patch: { limit: 4 } }, HOST);
  expect('能把一道菜设成限量 4 份（' + water.name + '）', r.ok === true, r.msg);

  /* --- 家宴设置 --- */
  r = await call('updateConfig', { patch: { title: '周六家宴', maxDishesPerOrder: 8 } }, HOST);
  expect('改标题与每人上限', r.ok && r.data.title === '周六家宴' && r.data.maxDishesPerOrder === 8, JSON.stringify(r.data));
  r = await call('updateConfig', { patch: { title: 'x' } }, GUEST_C);
  expect('非管理员不能改设置', r.ok === false, r.msg);

  /* --- 下单 --- */
  const cartB = [
    { dishId: water._id, name: water.name, emoji: water.emoji, qty: 3, note: '多放醋' },
    { dishId: water._id, name: water.name, emoji: water.emoji, qty: 0, note: '这条应被过滤掉' }
  ];
  r = await call('submitOrder', { nick: '老王', partySize: 3, arriveAt: '18:00', note: '一位不吃香菜', items: cartB }, GUEST_B);
  expect('老王下单成功', r.ok && r.data.updated === false, JSON.stringify(r.data));

  r = await call('myOrder', {}, GUEST_B);
  const orderB = r.data.order;
  expect('myOrder 能查到自己那一单', !!orderB && orderB.nick === '老王');
  expect('qty=0 的条目被过滤', orderB.items.length === 1, 'items=' + orderB.items.length);
  expect('myOrder 不外泄 _openid', orderB._openid === undefined);
  expect('订单计算出 totalQty', orderB.totalQty === 3, 'totalQty=' + orderB.totalQty);

  r = await call('submitOrder', { nick: '老王', partySize: 3, items: [{ dishId: water._id, qty: 2 }] }, GUEST_B);
  expect('重复提交是覆盖而不是新增一单', r.ok && r.data.updated === true);
  r = await call('summary', {}, HOST);
  expect('覆盖后只有 1 单', r.data.stats.orderCount === 1, 'orderCount=' + r.data.stats.orderCount);
  expect('覆盖后份数按新单算（2 份）', r.data.stats.totalDishes === 2, 'totalDishes=' + r.data.stats.totalDishes);

  /* --- 限量校验 --- */
  r = await call('submitOrder', { nick: '小李', partySize: 2, items: [{ dishId: water._id, qty: 3 }] }, GUEST_C);
  expect('限量校验：超量下单被拒绝', r.ok === false, r.msg);
  expect('拒绝信息提示剩余份数', /只剩|点完/.test(r.msg || ''), r.msg);

  r = await call('submitOrder', { nick: '小李', partySize: 2, items: [{ dishId: water._id, qty: 2 }] }, GUEST_C);
  expect('限量内下单成功', r.ok === true, r.msg);

  /* --- 每人上限：用不限量的菜才能真正测到上限规则 --- */
  r = await call('submitOrder', { nick: '小李', partySize: 2, items: [{ dishId: water._id, qty: 5 }] }, GUEST_C);
  expect('超过限量时同样被拒（限量优先于上限）', r.ok === false, r.msg);

  /* --- 下架校验 --- */
  const salad = (await call('listDishes', { all: true }, HOST)).data.dishes.find((d) => d._id !== water._id);
  await call('toggleDish', { id: salad._id, available: false }, HOST);
  r = await call('submitOrder', { nick: '小李', partySize: 2, items: [{ dishId: salad._id, qty: 1 }] }, GUEST_C);
  expect('点已下架的菜被拒绝', r.ok === false && /下架/.test(r.msg || ''), r.msg);
  await call('toggleDish', { id: salad._id, available: true }, HOST);

  /* --- 汇总看板 --- */
  r = await call('summary', {}, GUEST_C);
  expect('非管理员看不到后厨看板', r.ok === false, r.msg);

  r = await call('summary', {}, HOST);
  const sum = r.data;
  expect('汇总：2 单 / 5 人', sum.stats.orderCount === 2 && sum.stats.totalPeople === 5, JSON.stringify(sum.stats));
  expect('汇总：按人明细含昵称与人数', sum.orders.length === 2 && sum.orders.every((o) => o.nick && o.partySize));
  const waterTotal = sum.dishTotals.find((t) => t.name === water.name);
  expect('汇总：' + water.name + ' 合计 4 份（2+2）', waterTotal && waterTotal.qty === 4, JSON.stringify(waterTotal));
  expect('汇总：带出每个点单人的昵称', waterTotal && waterTotal.guests.length === 2, JSON.stringify(waterTotal && waterTotal.guests));
  expect('汇总：菜品按份数降序', sum.dishTotals.every((t, i) => i === 0 || sum.dishTotals[i - 1].qty >= t.qty));

  /* --- 朋友之间互相可见：「大家都在点什么」不需要主人权限 --- */
  r = await call('board', {}, GUEST_C);
  expect('朋友（非主人）也能拿到「大家都在点什么」', r.ok === true && r.data.inited === true, r.msg);
  expect('board 聚合出菜品份数与点单人',
    r.data.dishTotals.some((t) => t.dishId === water._id && t.qty === 4 && t.guests.length === 2),
    JSON.stringify(r.data.dishTotals));
  expect('board 带出每个人的点单',
    r.data.orders.length === 2 && r.data.orders.every((o) => o.nick && o.items.length),
    JSON.stringify(r.data.orders.map((o) => o.nick)));
  expect('board 不泄露主人口令', r.data.config.hostCode === undefined);
  expect('board 不泄露订单内部 id', r.data.orders.every((o) => o.orderId === undefined));
  expect('board 不泄露 openid / token', r.data.orders.every((o) => o._openid === undefined && o.token === undefined));
  expect('board 与主人看板用的是同一份聚合逻辑',
    r.data.stats.orderCount === sum.stats.orderCount && r.data.stats.totalDishes === sum.stats.totalDishes,
    JSON.stringify(r.data.stats) + ' vs ' + JSON.stringify(sum.stats));
  /* --- 主人自己的单要被标记（自测单会污染人数/份数） --- */
  const freeDish = (await call('listDishes', {}, GUEST_B)).data.dishes.find((d) => !d.limit);
  r = await call('submitOrder', { nick: '主人自测', partySize: 1, items: [{ dishId: freeDish._id, qty: 1 }] }, WIFE);
  expect('管理员（配偶）也能正常下单', r.ok === true, r.msg);

  r = await call('summary', {}, HOST);
  const hostOrder = r.data.orders.find((o) => o.nick === '主人自测');
  const guestOrder = r.data.orders.find((o) => o.nick === '老王');
  expect('汇总把管理员自己的单标记为 isHost', !!hostOrder && hostOrder.isHost === true, JSON.stringify(hostOrder && hostOrder.isHost));
  expect('朋友的单不会被标记成 isHost', !!guestOrder && guestOrder.isHost === false, JSON.stringify(guestOrder && guestOrder.isHost));

  await call('cancelOrder', {}, WIFE);
  r = await call('summary', {}, HOST);
  expect('撤销自测单后汇总里不再有 isHost 标记', r.data.orders.every((o) => !o.isHost));

  /* --- 截止时间 --- */
  await call('updateConfig', { patch: { deadlineTs: Date.now() - 1000 } }, HOST);
  r = await call('submitOrder', { nick: '老王', partySize: 3, items: [{ dishId: water._id, qty: 1 }] }, GUEST_B);
  expect('截止后不能再下单', r.ok === false && /截止/.test(r.msg || ''), r.msg);
  r = await call('myOrder', {}, GUEST_B);
  expect('截止后仍然能查看自己的单', r.ok && !!r.data.order);
  await call('updateConfig', { patch: { deadlineTs: 0 } }, HOST);
  r = await call('submitOrder', { nick: '老王', partySize: 3, items: [{ dishId: water._id, qty: 1 }] }, GUEST_B);
  expect('取消截止后又能下单', r.ok === true, r.msg);

  /* --- 撤单 --- */
  r = await call('cancelOrder', {}, GUEST_B);
  expect('撤单成功', r.ok === true);
  r = await call('myOrder', {}, GUEST_B);
  expect('撤单后查不到自己的单', r.data.order === null);
  r = await call('summary', {}, HOST);
  expect('撤单后汇总只剩 1 单', r.data.stats.orderCount === 1, 'orderCount=' + r.data.stats.orderCount);

  /* --- 删除菜品不影响历史汇总 --- */
  await call('removeDish', { id: water._id }, HOST);
  r = await call('summary', {}, HOST);
  const still = r.data.dishTotals.find((t) => t.name === water.name);
  expect('删掉的菜在历史汇总里仍显示菜名', !!still && still.qty === 2, JSON.stringify(r.data.dishTotals));
  r = await call('listDishes', { all: true }, HOST);
  expect('删除后菜库剩 ' + (SEED.length - 1) + ' 道', r.data.dishes.length === SEED.length - 1, '实际=' + r.data.dishes.length);

  /* --- 参数防御与边界 --- */
  r = await call('submitOrder', { nick: '空单', partySize: 1, items: [] }, GUEST_C);
  expect('空点单被拒绝', r.ok === false, r.msg);

  r = await call('submitOrder', { nick: '全是零', partySize: 1, items: [{ dishId: salad._id, qty: 0 }] }, GUEST_C);
  expect('份数全为 0 的点单被拒绝', r.ok === false, r.msg);

  r = await call('submitOrder', { nick: '上限', partySize: 1, items: [{ dishId: salad._id, qty: 9 }] }, GUEST_C);
  expect('每人上限（8 道）生效并给出明确提示', r.ok === false && /最多点 8 道/.test(r.msg || ''), r.msg);

  r = await call('submitOrder', { nick: '刚好上限', partySize: 1, items: [{ dishId: salad._id, qty: 8 }] }, GUEST_C);
  expect('正好等于上限时允许提交', r.ok === true, r.msg);

  r = await call(
    'submitOrder',
    { nick: '很长的昵称'.repeat(10), partySize: 999, items: [{ dishId: salad._id, qty: 1 }] },
    GUEST_C
  );
  expect('极端人数 + 超长昵称仍能提交（服务端裁剪）', r.ok === true, r.msg);
  const trimmed = (await call('myOrder', {}, GUEST_C)).data.order;
  expect('昵称被裁剪到 20 字以内', !!trimmed && String(trimmed.nick).length <= 20,
    trimmed ? String(trimmed.nick).length + ' 字' : '无');
  expect('人数被裁剪到 1-50', !!trimmed && trimmed.partySize >= 1 && trimmed.partySize <= 50,
    trimmed ? String(trimmed.partySize) : '无');
  expect('超长备注也被裁剪', !!trimmed && String(trimmed.note || '').length <= 100);

  r = await call('updateConfig', { patch: { maxDishesPerOrder: 0 } }, HOST);
  expect('关掉每人上限后保存成功', r.ok && r.data.maxDishesPerOrder === 0);

  r = await call('不存在的action', {}, HOST);
  expect('未知 action 返回 ok=false', r.ok === false && /未知操作/.test(r.msg));

  /* --- 主人端调整点单：去掉菜品（两种范围） --- */
  // 注意：要从"现在"的菜谱里挑，不能用早先的快照——中间已经删过菜了
  const freshAll = (await call('listDishes', { all: true }, HOST)).data.dishes;
  const second = freshAll.find((d) => d.available && d._id !== salad._id);
  r = await call('submitOrder', { nick: '老王', partySize: 3, items: [{ dishId: salad._id, qty: 1 }, { dishId: second._id, qty: 1 }] }, GUEST_B);
  expect('准备数据：老王点了两道菜（' + salad.name + ' + ' + second.name + '）', r.ok === true, r.msg);
  r = await call('submitOrder', { nick: '小李', partySize: 2, items: [{ dishId: salad._id, qty: 2 }] }, GUEST_C);
  expect('准备数据：小李点了 ' + salad.name + ' ×2', r.ok === true, r.msg);

  let sum2 = (await call('summary', {}, HOST)).data;
  expect('汇总里带订单 id（主人端才能针对某一单调整）',
    sum2.orders.every((o) => !!o.orderId), JSON.stringify(sum2.orders.map((o) => o.orderId)));
  const wangOrder = sum2.orders.find((o) => o.nick === '老王');
  const liOrder = sum2.orders.find((o) => o.nick === '小李');

  r = await call('dropDish', { dishId: salad._id, orderId: wangOrder.orderId }, GUEST_C);
  expect('非管理员不能调整点单', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('dropDish', { orderId: wangOrder.orderId }, HOST);
  expect('不传菜品 id 会被拒绝', r.ok === false, r.msg);

  r = await call('dropDish', { dishId: salad._id, orderId: wangOrder.orderId }, HOST);
  expect('去掉某一单里的某道菜 → 只影响 1 单', r.ok && r.data.touched === 1, JSON.stringify(r.data));

  r = await call('myOrder', {}, GUEST_B);
  const wangAfter = r.data.order;
  expect('老王的单只剩另一道菜', wangAfter.items.length === 1 && wangAfter.items[0].dishId === second._id, JSON.stringify(wangAfter.items));
  expect('老王的单份数被重算', wangAfter.totalQty === 1, 'totalQty=' + wangAfter.totalQty);
  expect('老王的单留下"主人调整过"的说明', /主人去掉了/.test(wangAfter.hostNote || ''), wangAfter.hostNote);

  r = await call('myOrder', {}, GUEST_C);
  expect('小李的单完全没被动', r.data.order.items.length === 1 && r.data.order.items[0].dishId === salad._id);
  expect('没被动过的单不会被写说明', !r.data.order.hostNote, r.data.order.hostNote);

  /* 从所有订单里去掉这道菜 */
  r = await call('dropDish', { dishId: salad._id }, HOST);
  expect('「这道菜不做了」→ 影响到的单数正确', r.ok && r.data.touched === 1, JSON.stringify(r.data));
  expect('空掉的那一单被整单删除', r.data.emptied === 1, JSON.stringify(r.data));
  expect('从所有订单去掉时会顺手下架这道菜', r.data.unlisted === true, JSON.stringify(r.data));

  sum2 = (await call('summary', {}, HOST)).data;
  expect('小李的单已随空单删除（只剩老王一单）', sum2.stats.orderCount === 1, 'orderCount=' + sum2.stats.orderCount);
  expect('汇总里不再有这道菜', !sum2.dishTotals.some((t) => t.dishId === salad._id), JSON.stringify(sum2.dishTotals.map((t) => t.name)));
  r = await call('listDishes', { all: true }, HOST);
  expect('这道菜在下架之后朋友端看不到', (await call('listDishes', {}, GUEST_B)).data.dishes.every((d) => d._id !== salad._id));
  expect('菜谱里它还在，只是下架了', r.data.dishes.some((d) => d._id === salad._id && d.available === false));

  /* 朋友重新提交后，调整说明要清掉（否则会一直挂着） */
  await call('submitOrder', { nick: '老王', partySize: 3, items: [{ dishId: second._id, qty: 2 }] }, GUEST_B);
  r = await call('myOrder', {}, GUEST_B);
  expect('朋友重新提交后"主人调整过"的说明被清掉', !r.data.order.hostNote, JSON.stringify(r.data.order.hostNote));

  /* --- 主人端改份数：朋友误点多了，主人减掉 --- */
  r = await call('submitOrder', { nick: '老王', partySize: 3, items: [{ dishId: second._id, qty: 3 }] }, GUEST_B);
  expect('准备数据：老王点了 3 份 ' + second.name, r.ok === true, r.msg);

  let sum3 = (await call('summary', {}, HOST)).data;
  const wangOrder3 = sum3.orders.filter((o) => o.nick === '老王')[0];
  expect('准备数据：能定位到订单 id', !!wangOrder3 && !!wangOrder3.orderId, JSON.stringify(sum3.orders.map((o) => o.nick)));

  r = await call('setItemQty', { orderId: wangOrder3.orderId, dishId: second._id, qty: 1 }, GUEST_C);
  expect('非管理员不能改份数', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('setItemQty', { orderId: wangOrder3.orderId, dishId: second._id }, HOST);
  expect('漏传份数会被拒绝（不能默认成 0 份误删）', r.ok === false && /份数/.test(r.msg), r.msg);
  r = await call('setItemQty', { orderId: 'nope', dishId: second._id, qty: 1 }, HOST);
  expect('订单不存在时给明确提示', r.ok === false && /不在了/.test(r.msg), r.msg);

  r = await call('setItemQty', { orderId: wangOrder3.orderId, dishId: second._id, qty: 1 }, HOST);
  expect('把 3 份改成 1 份', r.ok && r.data.qty === 1 && r.data.totalQty === 1, JSON.stringify(r.data));
  r = await call('myOrder', {}, GUEST_B);
  expect('朋友端看到份数被改小', r.data.order.items[0].qty === 1 && r.data.order.totalQty === 1, JSON.stringify(r.data.order.items));
  expect('朋友端看到"主人改成了"的说明', /主人把/.test(r.data.order.hostNote || ''), r.data.order.hostNote);

  r = await call('setItemQty', { orderId: wangOrder3.orderId, dishId: second._id, qty: 200 }, HOST);
  expect('份数会被夹到上限 99', r.ok && r.data.qty === 99, JSON.stringify(r.data));

  r = await call('setItemQty', { orderId: wangOrder3.orderId, dishId: second._id, qty: 0 }, HOST);
  expect('改成 0 份 = 整条去掉，空单同时被删除',
    r.ok && r.data.qty === 0 && r.data.removedOrder === true, JSON.stringify(r.data));
  r = await call('myOrder', {}, GUEST_B);
  expect('整单删掉后朋友查不到单了', r.data.order === null);
  sum3 = (await call('summary', {}, HOST)).data;
  expect('汇总里这一单也消失了', !sum3.orders.some((o) => o.nick === '老王'), JSON.stringify(sum3.orders.map((o) => o.nick)));

  r = await call('setItemQty', { orderId: wangOrder3.orderId, dishId: second._id, qty: 1 }, HOST);
  expect('对已删除的订单再改份数 → 明确提示', r.ok === false && /不在了/.test(r.msg), r.msg);
}

/**
 * 兼容性回归：云开发 SDK 在不同版本/环境下行为不一致，
 * 云函数必须在这些差异下都不崩。
 *
 * 起因：线上第一次初始化报 "Cannot read properties of null (reading 'admins')"。
 * 根因是 saveConfig 依赖 doc().update() 在文档不存在时抛错，
 * 而真实 SDK 是静默返回 stats.updated = 0，导致配置从未创建、随后读回 null。
 * 当初 mock 是"抛错"行为，所以测试全绿却漏掉了这个 bug。
 */
async function runBackendCompatibility() {
  console.log('\n[A2] 兼容性回归：SDK 行为差异下也不能崩');

  const originalCollections = state.collections;

  /* ---- 场景 1：update 在文档不存在时静默失败（线上真实行为） ---- */
  state.collections = {};
  state.seq = 0;
  state.updateOnMissing = 'silent';
  state.configReadFails = false;

  let r = await call('whoami', {}, 'compat_host');
  expect('静默模式下 whoami 正常显示未初始化', r.ok && r.data.inited === false);

  r = await call('board', {}, 'compat_guest');
  expect('未初始化时「大家都在点什么」返回空且不报错',
    r.ok === true && r.data.inited === false && r.data.orders.length === 0, JSON.stringify(r.data));

  r = await call('init', {}, 'compat_host');
  expect('静默模式下 init 不再崩溃（回归点）', r.ok === true, r.msg || JSON.stringify(r.data));
  expect('静默模式下 init 返回主人身份', r.ok && r.data.isAdmin === true);
  const code = r.ok && r.data.config ? r.data.config.hostCode : '';

  r = await call('whoami', {}, 'compat_host');
  expect('静默模式下配置真的落库了（whoami 能读到）', r.ok && r.data.inited === true && r.data.config !== null);
  expect('静默模式下配置内容正确', r.ok && r.data.config && r.data.config.title === '周末家宴');

  r = await call('whoami', {}, 'compat_guest');
  expect('静默模式下朋友仍然是客人', r.ok && r.data.isAdmin === false);

  r = await call('init', { hostCode: code }, 'compat_wife');
  expect('静默模式下口令认领仍然有效', r.ok && r.data.isAdmin === true, r.msg);

  r = await call('seedDishes', { dishes: SEED }, 'compat_host');
  expect('静默模式下导入菜库正常', r.ok && r.data.added === SEED.length, JSON.stringify(r.data));

  await call('batchToggle', { available: true }, 'compat_host');
  r = await call('listDishes', {}, 'compat_guest');
  expect('静默模式下朋友端看到 ' + SEED.length + ' 道菜', r.ok && r.data.dishes.length === SEED.length, '实际=' + (r.ok ? r.data.dishes.length : r.msg));

  const compatDish = r.ok ? r.data.dishes[0] : null;
  r = await call('submitOrder', { nick: '兼容测试', partySize: 1, items: [{ dishId: compatDish._id, qty: 2 }] }, 'compat_guest');
  expect('静默模式下下单成功', r.ok === true, r.msg);

  r = await call('summary', {}, 'compat_host');
  expect('静默模式下汇总正常', r.ok && r.data.stats.orderCount === 1, JSON.stringify(r.ok ? r.data.stats : r.msg));

  r = await call('updateConfig', { patch: { title: '静默模式家宴' } }, 'compat_host');
  expect('静默模式下改设置后仍能读回', r.ok && r.data.title === '静默模式家宴', JSON.stringify(r.data));
  r = await call('whoami', {}, 'compat_host');
  expect('静默模式下改设置真的持久化了', r.ok && r.data.config.title === '静默模式家宴', r.ok ? r.data.config.title : r.msg);

  /* ---- 场景 2：配置读一直失败，init 也不能崩 ---- */
  state.collections = {};
  state.seq = 0;
  state.updateOnMissing = 'throw';
  state.configReadFails = true;

  r = await call('init', {}, 'blind_host');
  expect('读配置持续失败时 init 不崩、仍返回主人身份', r.ok === true && r.data.isAdmin === true, r.msg || JSON.stringify(r.data));

  /* ---- 场景 3：半成品配置（有文档但没管理员）要能自愈 ---- */
  state.configReadFails = false;
  state.collections = {};
  state.seq = 0;

  await call('init', {}, 'first_host');
  const cfgDoc = state.collections.config.find((d) => d._id === 'party');
  expect('初始化后 config 文档存在', !!cfgDoc);
  cfgDoc.admins = []; // 模拟"上次初始化中途失败留下的半成品"

  r = await call('init', {}, 'second_host');
  expect('半成品配置能被第一个到达的人认领（自愈）', r.ok === true && r.data.isAdmin === true, r.msg);

  r = await call('init', { hostCode: '0000' }, 'third_host');
  expect('认领之后别人仍然需要正确口令', r.ok === false && /口令/.test(r.msg), r.msg);

  state.collections = originalCollections;
}

/* ------------------------- 前端 ------------------------- */

function makeWxMock() {
  return {
    cloud: { init() {}, callFunction() {} },
    getStorageSync: () => '',
    setStorageSync() {},
    showToast() {},
    showModal() {},
    showLoading() {},
    hideLoading() {},
    setClipboardData() {},
    switchTab() {},
    navigateTo() {},
    navigateBack() {},
    stopPullDownRefresh() {}
  };
}

async function loadPages() {
  console.log('\n[B] 前端页面加载与纯逻辑');
  global.wx = makeWxMock();
  // 所有页面在 require 时就 getApp() 拿到同一个对象，所以这里做成单例：
  // 测试里可以临时改它的 ensureSession 来扮演"主人已登录"
  const appObj = {
    globalData: { openid: '', isAdmin: false, cfg: null },
    ensureSession: () => Promise.resolve({ inited: true, isAdmin: false, config: null }),
    refreshSession: () => Promise.resolve({})
  };
  global.getApp = () => appObj;

  let captured = null;
  global.App = (o) => {
    captured = { app: o };
  };
  global.Page = (o) => {
    captured = { page: o };
  };

  const files = {
    app: 'miniprogram/app.js',
    index: 'miniprogram/pages/index/index.js',
    mine: 'miniprogram/pages/mine/mine.js',
    menu: 'miniprogram/pages/admin/menu/menu.js',
    pantry: 'miniprogram/pages/admin/pantry/pantry.js',
    dashboard: 'miniprogram/pages/admin/dashboard/dashboard.js'
  };

  const loaded = {};
  Object.keys(files).forEach((key) => {
    captured = null;
    try {
      require(path.join(ROOT, files[key]));
      loaded[key] = captured && (captured.page || captured.app);
      ok('加载 ' + files[key]);
    } catch (e) {
      loaded[key] = null;
      bad('加载 ' + files[key], e.message);
    }
  });

  /* 页面方法齐全性 */
  const expectMethods = {
    index: ['bootstrap', 'buildShown', 'buildCats', 'dishRow', 'spyCat', 'measureSections', 'onPageScroll', 'onPlus', 'onMinus', 'onNote', 'onSubmit', 'onClearCart', 'reloadMenu', 'onInitAsHost', 'goMenu', 'goDashboard', 'onHide', 'onUnload', 'startDeadlineTick', 'stopDeadlineTick', 'onToggleBoard', 'loadBoard', 'mapBoard', 'onToggleLike', 'loadVotes', 'buildVoteList', 'onTapVote', 'onSubmitVotes', 'onClearVotes'],
    mine: ['refresh', 'applyOrder', 'onCancel', 'onCopy', 'onBecomeAdmin'],
    menu: ['load', 'buildGroups', 'onToggleDish', 'onToggleCategory', 'batchAll', 'onLimitEdit', 'onImportSeed', 'onFillIngredients', 'onSaveSettings', 'onClearDeadline', 'onToggleDeadline', 'goPantry', 'onShowCoverage'],
    pantry: ['load', 'render', 'putItem', 'onFormInput', 'onCatChange', 'onPickItem', 'onCancelEdit', 'onAdd', 'onRemove', 'onClearAll', 'onToggleQuick', 'onChipFilter', 'onToggleChip', 'onToggleBulk', 'onBulkInput', 'onBulkAdd', 'onRefresh'],
    dashboard: ['load', 'mapOrders', 'mapIngredients', 'mapLikes', 'groupByCat', 'buildMenuText', 'buildDishIngredientText', 'buildShoppingText', 'copyText', 'onCopyMenu', 'onCopyDishIngredient', 'onCopyShopping', 'onToggleIngredient', 'onResetShopping', 'onResetVotes', 'previewText', 'onRefresh', 'onShow', 'onHide', 'onUnload', 'startAutoRefresh', 'scheduleRefresh', 'stopAutoRefresh', 'onDropDish', 'onDropOrderItem', 'dropDish', 'onDecItem', 'onEditItemQty', 'setItemQty']
  };
  Object.keys(expectMethods).forEach((key) => {
    const page = loaded[key];
    if (!page) return bad('页面方法检查 ' + key, '页面未加载');
    const missing = expectMethods[key].filter((m) => typeof page[m] !== 'function');
    if (missing.length) bad('页面方法缺失 ' + key, missing.join(','));
    else ok('页面方法齐全 ' + key + '（' + expectMethods[key].length + ' 个）');
  });

  /* 购物车计算 */
  if (loaded.index) {
    const ctx = {
      data: {
        dishes: [
          { _id: 'd1', name: '红烧肉', category: '热菜', emoji: '🍖', desc: '', tags: ['硬菜'], limit: null },
          { _id: 'd2', name: '白灼虾', category: '热菜', emoji: '🦐', desc: '', tags: [], limit: null },
          { _id: 'd3', name: '拍黄瓜', category: '凉菜', emoji: '🥒', desc: '', tags: [], limit: null }
        ],
        activeCat: '全部'
      },
      cart: { d1: 2, d2: 1 },
      notes: { d1: '多放糖' },
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    // 页面对象上这几个方法本来就在一起（buildShown 会调 this.dishRow），假 ctx 也要照做
    ctx.buildShown = loaded.index.buildShown;
    ctx.buildCats = loaded.index.buildCats;
    ctx.dishRow = loaded.index.dishRow;
    loaded.index.buildShown.call(ctx);
    const dishesOnly = ctx.data.shown.filter((s) => s.type === 'dish');
    const headers = ctx.data.shown.filter((s) => s.type === 'header');
    expect('购物车：全部显示 3 道菜', dishesOnly.length === 3, 'shown=' + dishesOnly.length);
    expect('购物车：合计 3 份', ctx.data.cartCount === 3, 'cartCount=' + ctx.data.cartCount);
    expect('购物车：备注回填到菜品', dishesOnly[0].note === '多放糖', JSON.stringify(dishesOnly[0].note));

    /* 分组标题：选「全部」时每类菜前插一条，否则一路划下来所有菜连成一片 */
    expect('全部时插入了分组标题', headers.length === 2, JSON.stringify(headers.map((h) => h.name)));
    expect('分组标题按分类顺序排列', headers[0].name === '热菜' && headers[1].name === '凉菜', JSON.stringify(headers.map((h) => h.name)));
    expect('分组标题带该分类的菜数', headers[0].count === 2 && headers[1].count === 1, JSON.stringify(headers));
    expect('分组标题后面紧跟它自己的菜',
      ctx.data.shown[0].type === 'header' && ctx.data.shown[1].name === '红烧肉' && ctx.data.shown[3].type === 'header' && ctx.data.shown[4].name === '拍黄瓜',
      JSON.stringify(ctx.data.shown.map((s) => s.name)));
    expect('每行都有唯一 key（标题和菜品混在一起也不能重复）',
      new Set(ctx.data.shown.map((s) => s.key)).size === ctx.data.shown.length,
      ctx.data.shown.map((s) => s.key).join(','));

    /* 分类标签：带每类菜数 */
    const catData = loaded.index.buildCats(ctx.data.dishes);
    expect('分类标签第一项是「全部」且带总数',
      catData[0].name === '全部' && catData[0].count === 3, JSON.stringify(catData));
    expect('分类标签带各自菜数',
      catData.length === 3 && catData[1].name === '热菜' && catData[1].count === 2 && catData[2].count === 1,
      JSON.stringify(catData));

    /* 滚动联动：吸顶栏的高亮要跟着"当前看到的分类"走 */
    const sections = [
      { name: '热菜', top: 500 },
      { name: '凉菜', top: 1200 }
    ];
    const spy = (top, sticky) => loaded.index.spyCat(sections, top, sticky);
    expect('滚动联动：还在页面最上面时高亮「全部」', spy(0, 100) === '全部', spy(0, 100));
    expect('滚动联动：还没滚到第一个分组标题前仍是「全部」', spy(380, 100) === '全部', spy(380, 100));
    expect('滚动联动：越过第一个分组标题就切到该类', spy(400, 100) === '热菜', spy(400, 100));
    expect('滚动联动：继续往下滚就换成后一类的标题', spy(1150, 100) === '凉菜', spy(1150, 100));
    expect('滚动联动：吸顶栏自身高度算进判定（不会慢一拍）',
      loaded.index.spyCat([{ name: '热菜', top: 500 }], 400, 0) === '全部' &&
        loaded.index.spyCat([{ name: '热菜', top: 500 }], 400, 100) === '热菜',
      '吸顶高度 0/100 的结果应不同');
    expect('滚动联动：选了具体分类（没有分组标题）时始终「全部」',
      loaded.index.spyCat([], 9999, 100) === '全部' && loaded.index.spyCat(null, 0, 0) === '全部');

    ctx.data.activeCat = '凉菜';
    loaded.index.buildShown.call(ctx);
    expect('选中具体分类时不插标题、只显示该类',
      ctx.data.shown.length === 1 && ctx.data.shown[0].type === 'dish' && ctx.data.shown[0].name === '拍黄瓜',
      JSON.stringify(ctx.data.shown.map((s) => s.name)));
    expect('分类筛选时合计份数不变（3 份）', ctx.data.cartCount === 3, 'cartCount=' + ctx.data.cartCount);

    /* 回归：主人下架某道菜后，朋友购物车里的它必须被清掉
       （否则底部计数多算、提交被服务端拒绝，而界面上没有那一行可以减） */
    ctx.data.activeCat = '全部';
    ctx.cart.d9 = 5;
    ctx.notes.d9 = '已经下架的菜';
    loaded.index.buildShown.call(ctx);
    expect('已下架的菜被剔出购物车：不再计入总数', ctx.data.cartCount === 3, 'cartCount=' + ctx.data.cartCount);
    expect('已下架的菜被剔出购物车：条目和备注都清掉',
      ctx.cart.d9 === undefined && ctx.notes.d9 === undefined,
      JSON.stringify({ cart: ctx.cart, notes: ctx.notes }));
    expect('剔除后仍能正常渲染菜单', ctx.data.shown.filter((s) => s.type === 'dish').length === 3,
      'dish 行数=' + ctx.data.shown.filter((s) => s.type === 'dish').length);

    /* 「大家都在点什么」：朋友之间互相可见的那份数据的整理 */
    const bd = loaded.index.mapBoard({
      stats: { orderCount: 2, totalPeople: 5, totalDishes: 7 },
      dishTotals: [{ dishId: 'd1', emoji: '🍖', name: '红烧肉', qty: 3, guests: ['老王', '小李'] }],
      orders: [
        { nick: '老王', partySize: 3, isHost: false, items: [{ name: '红烧肉', qty: 2 }] },
        { nick: '老王', partySize: 1, isHost: true, items: [{ name: '拍黄瓜', qty: 1 }] }
      ]
    });
    expect('朋友看板：菜品行带份数和点单人',
      bd.totals[0].qty === 3 && bd.totals[0].guestsText === '老王、小李', JSON.stringify(bd.totals[0]));
    expect('朋友看板：同名的人 key 仍然唯一（不能拿昵称当 key）',
      bd.orders[0].key !== bd.orders[1].key, bd.orders.map((o) => o.key).join(','));
    expect('朋友看板：主人的单会被标出来', bd.orders[1].nick.indexOf('（主人）') >= 0, bd.orders[1].nick);
    expect('朋友看板：按人明细压成一行文字', bd.orders[0].itemsText === '红烧肉 ×2', bd.orders[0].itemsText);
    expect('朋友看板：缺字段时不崩', loaded.index.mapBoard({}).stats.orderCount === 0);

    /* 提交前要用"现在"重新判定截止状态（页面可能已经开了很久） */
    const obCtx = {
      data: { closed: false, cartCount: 3, showSubmit: false, nick: '老王' },
      syncDeadline() {
        this.data.closed = true; // 模拟本地重算后发现已经截止
      },
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.index.onOpenSubmit.call(obCtx);
    expect('页面开着很久后：已截止就不弹提交框', obCtx.data.showSubmit === false, JSON.stringify(obCtx.data));

    const obCtx2 = {
      data: { closed: false, cartCount: 3, showSubmit: false, nick: '老王' },
      syncDeadline() {
        this.data.closed = false;
      },
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.index.onOpenSubmit.call(obCtx2);
    expect('未截止时正常弹出提交框', obCtx2.data.showSubmit === true);

    const obCtx3 = {
      data: { closed: false, cartCount: 0, showSubmit: false, nick: '老王' },
      syncDeadline() {
        this.data.closed = false;
      },
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.index.onOpenSubmit.call(obCtx3);
    expect('一道菜都没点时不会弹出提交框', obCtx3.data.showSubmit === false);

    /* 点菜页的倒计时计时器：同样不能泄漏、不能留在后台 */
    const realSetInterval2 = global.setInterval;
    const realClearInterval2 = global.clearInterval;
    let activeTimers2 = 0;
    global.setInterval = function (fn, ms) {
      activeTimers2 += 1;
      return realSetInterval2(fn, ms);
    };
    global.clearInterval = function (t) {
      if (t) activeTimers2 -= 1;
      return realClearInterval2(t);
    };
    try {
      const tickCtx = {
        data: {},
        setData(d) {
          Object.assign(this.data, d);
        },
        syncDeadline() {}
      };
      tickCtx.startDeadlineTick = loaded.index.startDeadlineTick;
      tickCtx.stopDeadlineTick = loaded.index.stopDeadlineTick;

      tickCtx.startDeadlineTick();
      expect('点菜页：启动倒计时刷新后持有定时器', !!tickCtx.deadlineTimer && activeTimers2 === 1, '活跃定时器=' + activeTimers2);
      tickCtx.startDeadlineTick();
      expect('点菜页：重复启动不会泄漏第二个定时器', activeTimers2 === 1, '活跃定时器=' + activeTimers2);
      tickCtx.stopDeadlineTick();
      expect('点菜页：停止后定时器被清空', tickCtx.deadlineTimer === null && activeTimers2 === 0, '活跃定时器=' + activeTimers2);

      const hideCtx2 = {
        stopped: 0,
        stopDeadlineTick() {
          this.stopped += 1;
        }
      };
      loaded.index.onHide.call(hideCtx2);
      loaded.index.onUnload.call(hideCtx2);
      expect('点菜页：离开页面都会停止倒计时刷新', hideCtx2.stopped === 2, 'stopped=' + hideCtx2.stopped);
    } finally {
      global.setInterval = realSetInterval2;
      global.clearInterval = realClearInterval2;
    }
  }

  /* 我的点单明细 */
  if (loaded.mine) {
    const ctx = {
      data: {},
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.mine.applyOrder.call(ctx, {
      nick: '老王',
      partySize: 3,
      totalQty: 4,
      hostNote: '主人去掉了：拍黄瓜',
      items: [
        { dishId: 'd1', name: '红烧肉', emoji: '🍖', qty: 2, note: '多放糖' },
        { dishId: 'd2', name: '白灼虾', emoji: '🦐', qty: 2, note: '' }
      ],
      createdAt: new Date('2026-09-10T12:00:00Z')
    });
    expect('我的点单：解开 2 条明细', ctx.data.items.length === 2);
    expect('我的点单：保留每道菜备注', ctx.data.items[0].note === '多放糖');
    expect('我的点单：生成提交时间', !!ctx.data.submittedAt, ctx.data.submittedAt);
    expect('我的点单：显示"主人调整过"的说明', ctx.data.hostNote === '主人去掉了：拍黄瓜', ctx.data.hostNote);

    loaded.mine.applyOrder.call(ctx, null);
    expect('我的点单：清空后 items 为空', ctx.data.items.length === 0 && ctx.data.order === null);
    expect('我的点单：清空后调整说明也清掉', ctx.data.hostNote === '', JSON.stringify(ctx.data.hostNote));
  }

  /* 菜库分组统计 */
  if (loaded.menu) {
    const ctx = {
      all: [
        { _id: 'a', name: '拍黄瓜', category: '凉菜', available: true },
        { _id: 'b', name: '口水鸡', category: '凉菜', available: false },
        { _id: 'c', name: '红烧肉', category: '热菜', available: true }
      ],
      data: {},
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.menu.buildGroups.call(ctx);
    expect('菜库分组：2 个分类', ctx.data.groups.length === 2, 'groups=' + ctx.data.groups.length);
    expect('菜库分组：凉菜 1/2 上架', ctx.data.groups[0].onCount === 1 && ctx.data.groups[0].dishes.length === 2);
    expect('菜库分组：上架总数 2 / 总数 3', ctx.data.onCount === 2 && ctx.data.total === 3 && ctx.data.offCount === 1);
  }

  /* 截止时间取值：不能"没打算设，却被设上了" */
  const fmtUtil = require(path.join(ROOT, 'miniprogram', 'utils', 'format.js'));
  expect(
    '截止开关关掉 → 保存为 0（不限时间）',
    fmtUtil.deadlineForSave(false, '2026-09-12', '10:00') === 0,
    String(fmtUtil.deadlineForSave(false, '2026-09-12', '10:00'))
  );
  expect(
    '截止开关打开 → 按选的时间保存',
    fmtUtil.deadlineForSave(true, '2026-09-12', '10:00') === new Date(2026, 8, 12, 10, 0, 0, 0).getTime(),
    new Date(fmtUtil.deadlineForSave(true, '2026-09-12', '10:00')).toString()
  );
  expect('过去的时间会被识别出来（保存前提醒）', fmtUtil.isPastDeadline(Date.now() - 60000) === true);
  expect('未来的时间不会被误判为过期', fmtUtil.isPastDeadline(Date.now() + 86400000) === false);
  expect('0（不限时间）不算已过期', fmtUtil.isPastDeadline(0) === false);

  /* 改份数输入框的内容解析（用户手输的数字最容易出边界 bug） */
  expect('份数解析：正常数字', fmtUtil.parseQtyInput('2') === 2 && fmtUtil.parseQtyInput(' 3 ') === 3);
  expect('份数解析：0 表示整条去掉', fmtUtil.parseQtyInput('0') === 0);
  expect('份数解析：空输入 → null（不改）', fmtUtil.parseQtyInput('') === null && fmtUtil.parseQtyInput(null) === null);
  expect('份数解析：非数字 → null（不改）', fmtUtil.parseQtyInput('两个') === null && fmtUtil.parseQtyInput('abc') === null);
  expect('份数解析：负数按 0', fmtUtil.parseQtyInput('-3') === 0);
  expect('份数解析：超过 99 夹到 99', fmtUtil.parseQtyInput('200') === 99);
  expect('份数解析：小数向下取整', fmtUtil.parseQtyInput('2.9') === 2);

  /* 三种导出（都不含"谁点的"） */
  if (loaded.dashboard) {
    const totals = [
      { dishId: 'd1', name: '红烧肉', qty: 3, category: '猪肉', guestsText: '老王、小李', ingredients: ['五花肉', '冰糖', '生抽'] },
      { dishId: 'd2', name: '清炒丝瓜', qty: 1, category: '蔬菜', guestsText: '小李', ingredients: ['丝瓜', '大蒜'] }
    ];

    const menuText = loaded.dashboard.buildMenuText({ title: '周末家宴', address: '3 幢 1502' }, totals);
    expect('菜单清单：含标题、地址与分类', menuText.indexOf('周末家宴 · 菜单') >= 0 && menuText.indexOf('3 幢 1502') >= 0 && menuText.indexOf('【猪肉】') >= 0 && menuText.indexOf('【蔬菜】') >= 0, menuText);
    expect('菜单清单：只有菜名，不带份数', menuText.indexOf('· 红烧肉') >= 0 && menuText.indexOf('×3') < 0, menuText);
    expect('菜单清单：结尾给出总道数', menuText.indexOf('共 2 道菜') >= 0, menuText);
    expect('菜单清单：无人点单/未定菜时不崩', loaded.dashboard.buildMenuText({}, []).indexOf('（还没有确定菜品）') >= 0);

    const diText = loaded.dashboard.buildDishIngredientText({ title: '周末家宴' }, totals);
    expect('菜+食材：每道菜带份数与食材', diText.indexOf('红烧肉 ×3') >= 0 && diText.indexOf('食材：五花肉、冰糖、生抽') >= 0, diText);
    expect('菜+食材：没配食材的菜有占位提示',
      loaded.dashboard.buildDishIngredientText({}, [{ name: '神秘菜', qty: 1, category: '其他' }]).indexOf('（还没配食材）') >= 0);

    const ingList = loaded.dashboard.mapIngredients([
      { name: '五花肉', purchased: false, dishes: ['红烧肉'] },
      { name: '冰糖', purchased: true, dishes: ['红烧肉', '话梅排骨'] }
    ]);
    expect('食材清单：整理成渲染数据（带涉及哪些菜）',
      ingList[0].name === '五花肉' && ingList[0].dishesText === '红烧肉' && ingList[0].purchased === false && ingList[1].purchased === true,
      JSON.stringify(ingList));

    const shopText = loaded.dashboard.buildShoppingText({ title: '周末家宴' }, ingList);
    expect('待购清单：只列还没买的', shopText.indexOf('· 五花肉') >= 0 && shopText.indexOf('· 冰糖') < 0, shopText);
    expect('待购清单：给出还要买几项', shopText.indexOf('还要买 1 项') >= 0 && shopText.indexOf('已买 1 项') >= 0, shopText);
    expect('待购清单：全买完时给明确提示',
      loaded.dashboard.buildShoppingText({}, [{ name: '冰糖', purchased: true }]).indexOf('要用的 1 项全都齐了') >= 0);
    expect('待购清单：没有食材时不崩',
      loaded.dashboard.buildShoppingText({}, []).indexOf('（还没有食材清单）') >= 0);

    /* 家里已有的不算"还要买" */
    const stockIng = loaded.dashboard.mapIngredients([
      { name: '五花肉', purchased: false, dishes: ['红烧肉'] },
      { name: '冰糖', purchased: false, dishes: ['红烧肉', '话梅排骨'] },
      { name: '生抽', purchased: false, dishes: ['红烧肉'], inStock: true }
    ]);
    expect('食材清单：家里有会被标出来（含分组小标题）',
      stockIng[2].inStock === true && stockIng[2].showStockHeader === true && stockIng[0].showStockHeader === false,
      JSON.stringify(stockIng.map((i) => i.name + ':' + i.inStock + ':' + i.showStockHeader)));
    expect('食材清单：只有一个分组小标题', stockIng.filter((i) => i.showStockHeader).length === 1);
    expect('食材清单：旧版云函数不返回 inStock 时不崩', loaded.dashboard.mapIngredients([{ name: '盐' }])[0].inStock === false);

    const stockText = loaded.dashboard.buildShoppingText({ title: '周末家宴' }, stockIng);
    expect('待购清单：家里有的不列出来', stockText.indexOf('· 生抽') < 0 && stockText.indexOf('· 五花肉') >= 0, stockText);
    expect('待购清单：说明家里已有几项',
      stockText.indexOf('还要买 2 项') >= 0 && stockText.indexOf('家里已有 1 项') >= 0 && stockText.indexOf('（家里已有的 1 项没列出来）') >= 0,
      stockText);

    const cstats = loaded.dashboard.countStats(stockIng);
    expect('三个数按「家里有 / 已买 / 还要买」拆开算',
      cstats.total === 3 && cstats.inStock === 1 && cstats.purchased === 0 && cstats.missing === 2,
      JSON.stringify(cstats));
    const cstats2 = loaded.dashboard.countStats([
      { name: 'a', purchased: true, inStock: false },
      { name: 'b', purchased: true, inStock: true },
      { name: 'c', purchased: false, inStock: false }
    ]);
    expect('已买又家里有的，只算「家里有」（不能重复计数）',
      cstats2.inStock === 1 && cstats2.purchased === 1 && cstats2.missing === 1 && cstats2.total === 3,
      JSON.stringify(cstats2));

    /* 用户明确要求：复制内容不关心"谁点的" */
    expect('三种导出都不含谁点的（回归点）',
      [menuText, diText, shopText, stockText].every((t) => t.indexOf('老王') < 0 && t.indexOf('小李') < 0 && t.indexOf('按人明细') < 0 && t.indexOf('主人自己的单') < 0),
      'menu/di/shop/stock 四种文本里都不该出现点单人');

    /* 库存里记了什么也不该混进菜单文本（那是主人自己的家事） */
    expect('待购清单不泄露库存的备注/分类',
      stockText.indexOf('调料') < 0 && stockText.indexOf('灶台下') < 0, stockText);

    /* 按人明细的渲染 key：昵称可能重复，key 必须唯一（不能用昵称当 key） */
    const mapped = loaded.dashboard.mapOrders([
      { orderId: 'o1', nick: '老王', partySize: 2, totalQty: 1, items: [{ dishId: 'd1', name: '红烧肉', qty: 1 }] },
      { orderId: 'o2', nick: '老王', partySize: 1, totalQty: 2, isHost: true, items: [{ dishId: 'd1', name: '红烧肉', qty: 2 }] }
    ]);
    expect('看板：订单 id 透传（去掉某单里的菜要用）', mapped[0].orderId === 'o1' && mapped[1].orderId === 'o2',
      mapped.map((m) => m.orderId).join(','));
    expect('看板：两条同名订单的 key 仍然唯一',
      mapped[0].key !== mapped[1].key && new Set(mapped.map((m) => m.key)).size === 2,
      mapped.map((m) => m.key).join(', '));
    expect('看板：菜品条目也有各自的唯一 key',
      mapped[0].items[0].key !== mapped[1].items[0].key,
      mapped[0].items[0].key + ' vs ' + mapped[1].items[0].key);
    expect('看板：isHost 原样透传（true/false 都要正确）',
      mapped[1].isHost === true && mapped[0].isHost === false,
      mapped.map((m) => String(m.isHost)).join(', '));
    expect('看板：缺字段时不崩（旧版云函数没有 isHost）',
      loaded.dashboard.mapOrders([{ nick: 'x' }])[0].isHost === false &&
        loaded.dashboard.mapOrders([{ nick: 'x' }])[0].items.length === 0);

    /* 自动刷新：下单期间 2 秒一次，截止后降频，且离开页面必须清掉定时器 */
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let activeTimers = 0;
    let lastDelay = null;
    global.setTimeout = function (fn, ms) {
      activeTimers += 1;
      lastDelay = ms;
      return realSetTimeout(fn, ms);
    };
    global.clearTimeout = function (t) {
      if (t) activeTimers -= 1;
      return realClearTimeout(t);
    };

    try {
      const ctx = {
        data: { closed: false },
        setData(d) {
          Object.assign(this.data, d);
        },
        load() {
          return Promise.resolve();
        }
      };
      // 页面对象上这几个方法本来就在一起，假 ctx 也要照做
      ctx.startAutoRefresh = loaded.dashboard.startAutoRefresh;
      ctx.scheduleRefresh = loaded.dashboard.scheduleRefresh;
      ctx.stopAutoRefresh = loaded.dashboard.stopAutoRefresh;

      ctx.startAutoRefresh();
      expect('看板：下单期间的刷新间隔是 2 秒', lastDelay === 2000 && activeTimers === 1, 'delay=' + lastDelay + ' 活跃=' + activeTimers);

      ctx.startAutoRefresh();
      expect('看板：重复启动不会泄漏出第二个定时器', activeTimers === 1, '活跃定时器=' + activeTimers);

      ctx.stopAutoRefresh();
      expect('看板：停止后定时器被清空', ctx.autoTimer === null && activeTimers === 0, '活跃定时器=' + activeTimers);

      ctx.data.closed = true;
      ctx.startAutoRefresh();
      expect('看板：截止后降频到 15 秒（省云函数调用次数）', lastDelay === 15000, 'delay=' + lastDelay);
      ctx.stopAutoRefresh();

      const hideCtx = {
        stopped: 0,
        stopAutoRefresh() {
          this.stopped += 1;
        }
      };
      loaded.dashboard.onHide.call(hideCtx);
      loaded.dashboard.onUnload.call(hideCtx);
      expect('看板：离开页面（onHide/onUnload）都会停止自动刷新', hideCtx.stopped === 2, 'stopped=' + hideCtx.stopped);
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  }

  /* ---- 家里的库存：纯逻辑 ---- */
  const pantryUtil = require(path.join(ROOT, 'miniprogram', 'utils', 'pantry.js'));

  expect('库存分类只有三种且顺序固定', pantryUtil.CATS.join(',') === '食材,调料,其他', pantryUtil.CATS.join(','));

  expect('调料能自动认出来',
    ['生抽', '蒸鱼豉油', '薄盐生抽', '冰糖'].every((n) => pantryUtil.guessCat(n) === '调料'),
    ['生抽', '蒸鱼豉油', '薄盐生抽', '冰糖'].map(pantryUtil.guessCat).join(','));
  expect('食材不会被误判成调料',
    ['五花肉', '小葱', '生姜', '梭子蟹', '小米'].every((n) => pantryUtil.guessCat(n) === '食材'),
    ['五花肉', '小葱', '生姜', '梭子蟹', '小米'].map(pantryUtil.guessCat).join(','));
  expect('单字调料只做全等匹配（别把"油麦菜"吞进来）',
    pantryUtil.guessCat('油') === '调料' && pantryUtil.guessCat('盐') === '调料' &&
      pantryUtil.guessCat('油麦菜') === '食材' && pantryUtil.guessCat('盐焗鸡') === '食材',
    ['油', '盐', '油麦菜', '盐焗鸡'].map(pantryUtil.guessCat).join(','));
  expect('空名字不崩', pantryUtil.guessCat('') === '食材' && pantryUtil.guessCat(null) === '食材');

  const bulk = pantryUtil.parseBulk('生抽 2瓶\n- 五花肉，1斤\n\n1. 小葱\n# 这是注释\n生抽 3瓶\n  生姜  ');
  expect('批量粘贴：一行一样，能带数量',
    bulk.length === 4 && bulk[0].name === '生抽' && bulk[0].qty === '2瓶' && bulk[1].name === '五花肉' && bulk[1].qty === '1斤',
    JSON.stringify(bulk));
  expect('批量粘贴：忽略空行、注释、序号和项目符号', bulk.map((i) => i.name).join(',') === '生抽,五花肉,小葱,生姜', bulk.map((i) => i.name).join(','));
  expect('批量粘贴：同名只留第一条', bulk.filter((i) => i.name === '生抽').length === 1 && bulk[0].qty === '2瓶');
  expect('批量粘贴：顺手把分类猜好', bulk[0].cat === '调料' && bulk[1].cat === '食材', JSON.stringify(bulk.map((i) => i.name + ':' + i.cat)));
  expect('批量粘贴：空文本不报错', pantryUtil.parseBulk('').length === 0 && pantryUtil.parseBulk(null).length === 0);

  const sortedItems = pantryUtil.sortItems([
    { name: '生抽', cat: '调料' },
    { name: '五花肉', cat: '食材' },
    { name: '咖啡豆', cat: '' },
    { name: '猫粮', cat: '其他' }
  ]);
  expect('库存排序：食材 → 调料 → 其他',
    sortedItems.map((i) => pantryUtil.normalizeCat(i.cat)).join(',') === '食材,食材,调料,其他',
    sortedItems.map((i) => i.name + ':' + i.cat).join(', '));

  const groups2 = pantryUtil.groupItems([{ name: '生抽', cat: '调料' }, { name: '五花肉', cat: '食材' }, { name: '猫粮', cat: '其他' }]);
  expect('库存分组：空分类不出现、count 跟条目数一致',
    groups2.map((g) => g.cat).join(',') === '食材,调料,其他' && groups2.every((g) => g.count === g.items.length),
    JSON.stringify(groups2.map((g) => g.cat + ':' + g.count)));
  expect('库存分组：空库存返回空数组', pantryUtil.groupItems([]).length === 0 && pantryUtil.groupItems(null).length === 0);

  const hotDish = { name: '红烧肉', ingredients: ['五花肉', '冰糖', '生抽'] };
  const haveMap = pantryUtil.toNameMap([{ name: '冰糖' }, { name: '生抽' }, { name: '猫粮' }]);
  const cov = pantryUtil.coverage(hotDish, haveMap);
  expect('够不够做：数得出家里有几样', cov.total === 3 && cov.haveCount === 2 && cov.full === false, JSON.stringify(cov));
  expect('够不够做：列得出缺的那几样', cov.missing.join(',') === '五花肉', cov.missing.join(','));
  expect('够不够做：短提示写"缺 N 样"', pantryUtil.coverageShort(cov) === '缺 1 样', pantryUtil.coverageShort(cov));
  expect('够不够做：点开能看到缺的名字', pantryUtil.coverageDetail('红烧肉', cov).indexOf('五花肉') >= 0, pantryUtil.coverageDetail('红烧肉', cov));

  const covFull = pantryUtil.coverage(hotDish, pantryUtil.toNameMap([{ name: '五花肉' }, { name: '冰糖' }, { name: '生抽' }]));
  expect('食材全有 → 标成"食材都有"', covFull.full === true && pantryUtil.coverageShort(covFull) === '食材都有', pantryUtil.coverageShort(covFull));

  const covEmpty = pantryUtil.coverage({ name: '神秘菜' }, haveMap);
  expect('没配食材的菜不算"齐了"（不然会误报）', covEmpty.total === 0 && covEmpty.full === false && pantryUtil.coverageShort(covEmpty) === '');
  expect('没配食材时给出补全引导', pantryUtil.coverageDetail('神秘菜', covEmpty).indexOf('补全食材') >= 0, pantryUtil.coverageDetail('神秘菜', covEmpty));

  const covAlias = pantryUtil.coverage({ name: 'x', ingredients: ['小葱'] }, pantryUtil.toNameMap([{ name: '葱' }]));
  expect('只做同名匹配，不猜同义词（小葱 ≠ 葱）', covAlias.haveCount === 0 && covAlias.missing.join(',') === '小葱', JSON.stringify(covAlias));

  /* ---- 菜单页：照着库存标"够不够做" ---- */
  if (loaded.menu) {
    const mctx = {
      all: [
        { _id: 'm1', name: '红烧肉', category: '猪肉', available: true, ingredients: ['五花肉', '冰糖', '生抽'] },
        { _id: 'm2', name: '小米南瓜粥', category: '主食', available: false, ingredients: ['小米', '南瓜'] }
      ],
      pantryNameMap: pantryUtil.toNameMap([{ name: '冰糖' }, { name: '生抽' }]),
      data: {},
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.menu.buildGroups.call(mctx);
    const rows = mctx.data.groups.reduce((a, g) => a.concat(g.dishes), []);
    expect('菜单页：每道菜标出「缺几样」',
      rows[0].haveShort === '缺 1 样' && rows[0].missingCount === 1 && rows[0].haveFull === false,
      JSON.stringify(rows.map((r) => r.name + ':' + r.haveShort)));
    expect('菜单页：分组统计没被破坏',
      mctx.data.groups.length === 2 && mctx.data.onCount === 1 && mctx.data.total === 2 && mctx.data.canCookCount === 0,
      JSON.stringify({ groups: mctx.data.groups.length, on: mctx.data.onCount, total: mctx.data.total, canCook: mctx.data.canCookCount }));

    mctx.pantryNameMap = pantryUtil.toNameMap([{ name: '小米' }, { name: '南瓜' }]);
    loaded.menu.buildGroups.call(mctx);
    expect('菜单页：食材齐了的菜会被数出来（挑菜时最有用）',
      mctx.data.canCookCount === 1 && mctx.data.groups[1].dishes[0].haveFull === true && mctx.data.groups[1].dishes[0].haveShort === '食材都有',
      JSON.stringify({ canCook: mctx.data.canCookCount, text: mctx.data.groups[1].dishes[0].haveShort }));

    const mctx2 = {
      all: [{ _id: 'm3', name: '自定义菜', category: '自定义', available: false, ingredients: ['五花肉'] }],
      pantryNameMap: {},
      data: {},
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.menu.buildGroups.call(mctx2);
    expect('菜单页：库存是空的时候一律不显示"缺几样"（否则满屏噪音，还像丢了数据）',
      mctx2.data.groups[0].dishes[0].haveShort === '' && mctx2.data.canCookCount === 0,
      JSON.stringify(mctx2.data.groups[0].dishes[0]));

    /* 用户最容易撞到的场景：代码更新了但云函数还没重新部署（旧版没有 listPantry）。
       这时菜单页必须照常能用，只是不显示"缺几样"。 */
    const menuApi = require(path.join(ROOT, 'miniprogram', 'utils', 'api.js'));
    const realCall = menuApi.call;
    const realToast = menuApi.toast;
    const realEnsure = appObj.ensureSession;
    let toastMsg = '';
    menuApi.call = (action) => {
      if (action === 'listDishes') {
        return Promise.resolve({
          dishes: [{ _id: 'x1', name: '红烧肉', category: '猪肉', available: true, ingredients: ['五花肉', '冰糖'] }]
        });
      }
      if (action === 'listPantry') return Promise.reject(new Error('未知操作：listPantry'));
      return Promise.resolve({});
    };
    menuApi.toast = (m) => {
      toastMsg = m;
    };
    appObj.ensureSession = () => Promise.resolve({ isAdmin: true, config: { title: '家宴' } });
    try {
      const lctx = {
        data: {},
        setData(d) {
          Object.assign(this.data, d);
        },
        buildGroups: loaded.menu.buildGroups
      };
      await loaded.menu.load.call(lctx);
      expect('云函数还是旧版（没有 listPantry）时，菜单页照常加载',
        lctx.data.loading === false && lctx.data.isAdmin === true && lctx.data.pantryCount === 0 && lctx.data.groups.length === 1,
        JSON.stringify({ loading: lctx.data.loading, admin: lctx.data.isAdmin, groups: lctx.data.groups.length }));
      expect('并且提示"可能还没重新部署"', /重新部署/.test(toastMsg), toastMsg);
      expect('读不到库存时菜品行不显示"缺几样"',
        lctx.data.groups[0].dishes[0].haveShort === '' && lctx.data.canCookCount === 0,
        JSON.stringify(lctx.data.groups[0].dishes[0]));
    } catch (e) {
      bad('云函数是旧版时菜单页不该崩', e.message);
    } finally {
      menuApi.call = realCall;
      menuApi.toast = realToast;
      appObj.ensureSession = realEnsure;
    }
  }

  /* ---- 库存页：本地状态整理 ---- */
  if (loaded.pantry) {
    const pctx = {
      items: [{ name: '生抽', cat: '调料', qty: '2瓶', note: '' }],
      all: [{ _id: 'd1', name: '红烧肉', ingredients: ['五花肉', '生抽'] }],
      data: { chipFilter: '' },
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    loaded.pantry.render.call(pctx);
    expect('库存页：分组与统计正确',
      pctx.data.groups.length === 1 && pctx.data.stats.total === 1 && pctx.data.stats.seasoning === 1,
      JSON.stringify(pctx.data.stats));
    expect('库存页：菜谱食材里"还没有的"排前面（正等着你点）',
      pctx.data.quickChips.map((c) => c.name).join(',') === '五花肉,生抽',
      pctx.data.quickChips.map((c) => c.name + ':' + c.have).join(','));
    expect('库存页：算出还有几种没点', pctx.data.quickMissing === 1 && pctx.data.ingredientCount === 2,
      JSON.stringify({ missing: pctx.data.quickMissing, total: pctx.data.ingredientCount }));

    loaded.pantry.putItem.call(pctx, { name: '五花肉', cat: '食材' });
    expect('库存页：本地新增后按分类重排（跟服务端顺序一致）', pctx.items.map((i) => i.name).join(',') === '五花肉,生抽', pctx.items.map((i) => i.name).join(','));

    loaded.pantry.putItem.call(pctx, { name: '生抽', cat: '调料', qty: '3瓶' });
    expect('库存页：同名不会变成两条', pctx.items.length === 2 && pctx.items.filter((i) => i.name === '生抽')[0].qty === '3瓶', JSON.stringify(pctx.items));
  }

  /* ---- 点赞：朋友端点选 / 看板点赞榜 ---- */
  if (loaded.index) {
    const likeCtx = {
      data: {
        voteCandidates: [
          { dishId: 'd1', name: '红烧肉', emoji: '🍖', qty: 2, ordered: true, likeCount: 3 },
          { dishId: 'd2', name: '拍黄瓜', emoji: '🥒', qty: 1, ordered: true, likeCount: 1 },
          { dishId: 'd3', name: '小米南瓜粥', emoji: '🥣', qty: 0, ordered: false, likeCount: 0 },
          { dishId: 'd4', name: '番茄炒蛋', emoji: '🍅', qty: 0, ordered: false, likeCount: 0 }
        ],
        maxVotes: 3
      },
      setData(d) {
        Object.assign(this.data, d);
      }
    };
    likeCtx.buildVoteList = loaded.index.buildVoteList;
    likeCtx.onTapVote = loaded.index.onTapVote;
    likeCtx.pickVotes = [];

    likeCtx.buildVoteList();
    expect('点赞页：初始一个都没选，候选都在',
      likeCtx.data.pickCount === 0 && likeCtx.data.voteList.length === 4 && likeCtx.data.voteList.every((v) => v.picked === false),
      JSON.stringify(likeCtx.data.voteList.map((v) => v.name + ':' + v.picked)));

    const tap = (id) => likeCtx.onTapVote.call(likeCtx, { currentTarget: { dataset: { id: id } } });
    tap('d1');
    tap('d2');
    expect('点赞页：点一下选中，计数跟着变',
      likeCtx.data.pickCount === 2 && likeCtx.data.voteList[0].picked === true && likeCtx.data.voteList[2].picked === false,
      '已选=' + likeCtx.data.pickCount);

    tap('d1');
    expect('点赞页：再点一下取消', likeCtx.data.pickCount === 1 && likeCtx.data.voteList[0].picked === false, '已选=' + likeCtx.data.pickCount);

    tap('d1');
    tap('d3');
    expect('点赞页：选满 3 道', likeCtx.data.pickCount === 3, '已选=' + likeCtx.data.pickCount);
    tap('d4'); // 第 4 道 → 应被挡住
    expect('点赞页：超过 3 道点不动（前 3 道保持选中）',
      likeCtx.data.pickCount === 3 && likeCtx.data.voteList[3].picked === false,
      JSON.stringify(likeCtx.data.voteList.map((v) => v.name + ':' + v.picked)));

    tap('d2'); // 已经选中的菜，点一下是取消（不受"已满 3 道"影响）
    expect('点赞页：选满之后仍然能取消已选的那道', likeCtx.data.pickCount === 2 && likeCtx.data.voteList[1].picked === false,
      JSON.stringify(likeCtx.data.voteList.map((v) => v.name + ':' + v.picked)));

    expect('点赞页：菜品行上的 👍N 会渲染出来',
      loaded.index.dishRow.call({ cart: {}, notes: {}, data: { likeMap: { d1: 3 } } }, { _id: 'd1', name: '红烧肉' }).likeText === '👍 3' &&
        loaded.index.dishRow.call({ cart: {}, notes: {}, data: { likeMap: {} } }, { _id: 'd9', name: '没赞过的菜' }).likeText === '',
      '有人赞显示 👍N，没人赞不显示');
  }

  if (loaded.dashboard) {
    const likes = loaded.dashboard.mapLikes([
      { dishId: 'd1', name: '红烧肉', emoji: '🍖', count: 5 },
      { dishId: 'd2', name: '拍黄瓜', emoji: '🥒', count: 2 },
      { dishId: 'd3', name: '小米南瓜粥', emoji: '🥣', count: 1 }
    ]);
    expect('看板点赞榜：给前三名发奖牌',
      likes[0].medal === '🥇' && likes[1].medal === '🥈' && likes[2].medal === '🥉',
      likes.map((l) => l.rank + l.medal).join(','));
    expect('看板点赞榜：进度条按头名归一化',
      likes[0].barPercent === 100 && likes[1].barPercent === 40 && likes[2].barPercent === 20,
      likes.map((l) => l.barPercent).join(','));
    expect('看板点赞榜：每项有唯一 key', new Set(likes.map((l) => l.key)).size === 3);
    expect('看板点赞榜：空数据不崩', loaded.dashboard.mapLikes([]).length === 0 && loaded.dashboard.mapLikes(undefined).length === 0);
  }

  /* 报错翻译：部署期最容易撞到的几类失败，必须给人能照做的提示 */
  const apiUtil = require(path.join(ROOT, 'miniprogram', 'utils', 'api.js'));

  async function expectRawErrorRejected(label, errMsg, pattern) {
    global.wx.cloud.callFunction = function (opts) {
      opts.fail({ errMsg: errMsg });
    };
    try {
      await apiUtil.call('whoami');
      bad(label, '没有抛错');
    } catch (e) {
      expect(label, pattern.test(e.message), e.message);
    }
  }

  async function expectResult(label, result, verify) {
    global.wx.cloud.callFunction = function (opts) {
      opts.success({ result: result });
    };
    try {
      const data = await apiUtil.call('whoami');
      verify(label, data);
    } catch (e) {
      bad(label, e.message);
    }
  }

  // 以下报错翻译测试是异步的，loadPages 已声明为 async
  await expectRawErrorRejected(
    '报错翻译：云函数未部署 → 告诉你去上传部署',
    'cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found',
    /还没部署/
  );
    await expectRawErrorRejected(
      '报错翻译：云环境未初始化 → 指向 config.js 的 envId',
      "cloud.callFunction:fail Error: errMsg: Cloud API isn't enabled, please call wx.cloud.init first",
      /云开发没有初始化成功/
    );
    await expectRawErrorRejected(
      '报错翻译：envId 不存在 → 指向 config.js 的 envId',
      'cloud.callFunction:fail Error: errCode: -601002 | errMsg: env not exists',
      /云环境 ID 不对/
    );
    await expectRawErrorRejected(
      '报错翻译：超时 → 提示改云函数超时时间',
      'cloud.callFunction:fail Error: timeout',
      /超时/
    );
    await expectRawErrorRejected(
      '报错翻译：网络失败 → 提示检查网络',
      'request:fail socket hang up',
      /网络异常/
    );
    await expectResult(
      '正常返回：解开 result.data',
      { ok: true, data: { openid: 'abc', isAdmin: true } },
      (label, data) => expect(label, data && data.openid === 'abc' && data.isAdmin === true, JSON.stringify(data))
    );

    // 业务错误单独验证（expectResult 只覆盖成功分支）
    global.wx.cloud.callFunction = function (opts) {
      opts.success({ result: { ok: false, msg: '点单已经截止啦' } });
    };
    try {
      await apiUtil.call('submitOrder');
      bad('业务错误：云函数返回 ok=false 时应抛错', '没有抛错');
    } catch (e) {
      expect('业务错误：原样透传中文提示', e.message === '点单已经截止啦', e.message);
    }

    // 环境不支持云开发
    const savedCloud = global.wx.cloud;
    global.wx.cloud = undefined;
    try {
      await apiUtil.call('whoami');
      bad('环境不支持云开发时应给出提示', '没有抛错');
    } catch (e) {
      expect('环境不支持云开发 → 提示调基础库版本', /基础库/.test(e.message), e.message);
    }
    global.wx.cloud = savedCloud;
}

/* ------------------------- 主流程 ------------------------- */

(async () => {
  console.log('家宴点菜 · 离线集成测试');
  try {
    await runBackend();
  } catch (e) {
    bad('后端测试异常中断', e && e.stack ? e.stack.split('\n')[0] : String(e));
  }
  try {
    await runBackendCompatibility();
  } catch (e) {
    bad('兼容性回归测试异常中断', e && e.stack ? e.stack.split('\n')[0] : String(e));
  }
  try {
    await loadPages();
  } catch (e) {
    bad('前端测试异常中断', e && e.stack ? e.stack.split('\n')[0] : String(e));
  }

  console.log('\n[C] 结果');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('  全部通过 ✅');
  }
})();
