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

  /* --- 场次：点赞按场次分开，"来过几次就能投几次" --- */
  const countOf = (totals, dishId) => {
    const hit = (totals || []).filter((t) => t.dishId === dishId)[0];
    return hit ? hit.count : 0;
  };
  const V1 = 'openid_repeat_guest';
  const STRANGER = 'openid_stranger';

  let s1 = (await call('summary', {}, HOST)).data.session;
  expect('第 1 场默认是 legacy 场次（老数据自动归位）', s1.id === 'party' && s1.no === 1, JSON.stringify(s1));
  r = await call('whoami', {}, GUEST_B);
  expect('朋友也能看到"现在是第几场"',
    r.data.config.sessionId === 'party' && r.data.config.sessionNo === 1 && !!r.data.config.sessionName,
    JSON.stringify({ id: r.data.config.sessionId, no: r.data.config.sessionNo, name: r.data.config.sessionName }));

  const allNow = (await call('listDishes', { all: true }, HOST)).data.dishes;
  const avail = allNow.filter((d) => d.available);
  const dishA = avail[0];
  const dishB = avail[1];

  // 第 1 场：一位客人点了 A 并给 A 点赞
  await call('submitOrder', { nick: '老客人', partySize: 2, items: [{ dishId: dishA._id, qty: 1 }] }, V1);
  r = await call('submitVotes', { dishIds: [dishA._id] }, V1);
  expect('第 1 场：点赞带上场次信息', r.ok && r.data.session.no === 1 && r.data.session.name, JSON.stringify(r.data.session));
  r = await call('votes', {}, V1);
  expect('第 1 场：isCurrent 为 true', r.data.isCurrent === true && r.data.session.no === 1);
  expect('第 1 场：票记在我名下', r.data.myVotes.length === 1 && countOf(r.data.totals, dishA._id) === 1, JSON.stringify(r.data.totals));

  r = await call('myDinners', {}, V1);
  expect('「我参加过的场次」此时只有第 1 场',
    r.data.dinners.length === 1 && r.data.dinners[0].current === true && r.data.dinners[0].ordered === true && r.data.dinners[0].voted === true,
    JSON.stringify(r.data.dinners));
  expect('场次里带着那一场投过的菜名（朋友端要显示）',
    r.data.dinners[0].voteNames.length === 1 && r.data.dinners[0].voteNames[0] === dishA.name,
    JSON.stringify(r.data.dinners[0].voteNames));

  /* 开新的一场 */
  r = await call('newSession', { name: '中秋家宴' }, GUEST_C);
  expect('非管理员不能开始新的一场', r.ok === false && /权限/.test(r.msg), r.msg);

  // 先留一个"已采购"勾选，验证开新场会重置
  const ingName = (dishA.ingredients || [])[0];
  await call('toggleIngredient', { name: ingName, purchased: true }, HOST);
  const purchasedBefore = (await call('summary', {}, HOST)).data.ingredientStats.purchased;

  r = await call('newSession', { name: '中秋家宴' }, HOST);
  expect('开始新的一场：序号 +1、名字记下、上一场也返回',
    r.ok && r.data.session.no === 2 && r.data.session.name === '中秋家宴' && r.data.prev.id === 'party',
    JSON.stringify(r.data));

  r = await call('summary', {}, HOST);
  expect('新一场的看板是空的（上一场的订单不会混进来）', r.data.stats.orderCount === 0, JSON.stringify(r.data.stats));
  expect('新一场的看板带场次列表（两场都在）',
    r.data.session.no === 2 && r.data.sessions.length === 2 && r.data.sessions[0].no === 2,
    JSON.stringify(r.data.sessions.map((s) => s.no + ':' + s.name)));
  expect('开新场会重置「已采购」勾选（那是上一场买菜用的）',
    purchasedBefore > 0 && r.data.ingredientStats.purchased === 0,
    '之前=' + purchasedBefore + ' 现在=' + r.data.ingredientStats.purchased);

  r = await call('votes', { sessionId: 'party' }, V1);
  expect('回到第 1 场：候选来自那一场的订单（订单没被新场次清掉）',
    r.data.candidates.some((c) => c.dishId === dishA._id && c.ordered === true) && r.data.isCurrent === false,
    JSON.stringify(r.data.candidates.slice(0, 3).map((c) => c.name + ':' + c.ordered)));
  expect('回到第 1 场：候选里不会混进"现在上架的新菜"（那是现在的菜单）',
    r.data.candidates.every((c) => c.ordered === true),
    JSON.stringify(r.data.candidates.map((c) => c.name + ':' + c.ordered)));
  expect('回到第 1 场：我那一场的票还在（跟本场的票分开存）',
    r.data.myVotes.length === 1 && r.data.myVotes[0] === dishA._id,
    JSON.stringify(r.data.myVotes));

  /* 同一道菜，同一个人，在第 2 场再投一次 —— 这是允许的 */
  await call('submitOrder', { nick: '老客人', partySize: 2, items: [{ dishId: dishA._id, qty: 2 }] }, V1);
  r = await call('submitVotes', { dishIds: [dishA._id] }, V1);
  expect('第 2 场：同一个人给同一道菜再投一次是允许的',
    r.ok && r.data.count === 1 && r.data.session.no === 2, JSON.stringify(r.data));
  r = await call('votes', {}, V1);
  expect('累计榜把两场加起来（这道菜 2 票）', countOf(r.data.totalsAll, dishA._id) === 2, JSON.stringify(r.data.totalsAll));
  expect('本场榜只算这一场（1 票）', countOf(r.data.totals, dishA._id) === 1, JSON.stringify(r.data.totals));
  expect('"我投了哪些"是分开的：回到第 1 场读到的仍是那一场的票',
    r.data.myVotes[0] === dishA._id && r.data.isCurrent === true);

  r = await call('myDinners', {}, V1);
  expect('「我参加过的场次」变成 2 个，当前那一场排最前',
    r.data.dinners.length === 2 && r.data.dinners[0].current === true && r.data.dinners[0].no === 2 && r.data.dinners[1].no === 1,
    JSON.stringify(r.data.dinners.map((d) => d.no + ':' + d.name + (d.current ? '*' : ''))));
  expect('老那场标着"我投过"（能回去改票）', r.data.dinners[1].voted === true && r.data.dinners[0].voted === true,
    JSON.stringify(r.data.dinners.map((d) => d.voted)));

  r = await call('submitVotes', { dishIds: [dishB._id], sessionId: 'party' }, V1);
  expect('回旧场次改票：提交成功且只影响那一场', r.ok && r.data.session.no === 1, JSON.stringify(r.data.session));
  r = await call('votes', { sessionId: 'party' }, V1);
  expect('旧场次的票被改成新选的那道', r.data.myVotes.length === 1 && r.data.myVotes[0] === dishB._id, JSON.stringify(r.data.myVotes));
  r = await call('votes', {}, V1);
  expect('改旧场次的票不会动到本场的票', r.data.myVotes[0] === dishA._id, JSON.stringify(r.data.myVotes));

  r = await call('submitVotes', { dishIds: [dishB._id], sessionId: 'party' }, STRANGER);
  expect('没参加过的场次不能投票', r.ok === false && /没参加/.test(r.msg), r.msg);
  r = await call('submitVotes', { dishIds: [dishA._id] }, STRANGER);
  expect('当前这一场：我本人没点单也能投（只要这一场已经开席了）', r.ok === true, r.msg);

  r = await call('resetVotes', { sessionId: 'party' }, GUEST_C);
  expect('非管理员不能清空某一场的点赞', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('resetVotes', { sessionId: 'party' }, HOST);
  expect('清空指定场次的点赞：只清那一场', r.ok && r.data.cleared >= 1 && r.data.sessionId === 'party', JSON.stringify(r.data));
  r = await call('votes', {}, V1);
  expect('清掉旧场次后，那一场的票从累计里消失（dishB 归零）', countOf(r.data.totalsAll, dishB._id) === 0, JSON.stringify(r.data.totalsAll));
  expect('本场那 1 票不受影响', countOf(r.data.totalsAll, dishA._id) >= 1, JSON.stringify(r.data.totalsAll));

  /* 老环境升级上来：没有 sessionId 的老数据算第 1 场 */
  state.collections.orders.push({
    _id: 'legacy_order_1',
    _openid: 'openid_legacy',
    nick: '老数据',
    partySize: 1,
    items: [{ dishId: avail[2]._id, name: avail[2].name, emoji: '🍽', qty: 1 }],
    totalQty: 1,
    createdAt: new Date()
  });
  r = await call('myDinners', {}, 'openid_legacy');
  expect('老数据（没有 sessionId）算作第 1 场：出现在"我参加过的"里',
    r.data.dinners.filter((d) => d.no === 1 && d.ordered === true).length === 1,
    JSON.stringify(r.data.dinners.map((d) => d.no + ':' + d.ordered)));
  expect('当前这一场永远在列表最前（没参加过也能先点赞）',
    r.data.dinners[0].current === true && r.data.dinners[0].ordered === false,
    JSON.stringify(r.data.dinners.map((d) => d.no + (d.current ? '*' : ''))));
  r = await call('votes', { sessionId: 'party' }, 'openid_legacy');
  expect('老数据能在第 1 场投票（参与判定也认老数据）', r.data.canVote === true && r.data.candidates.some((c) => c.dishId === avail[2]._id), JSON.stringify(r.data.candidates.map((c) => c.name)));
  r = await call('votes', {}, 'openid_legacy');
  expect('老数据的老订单不会串到第 2 场（候选里"点过的"只来自本场订单）',
    r.data.candidates.filter((c) => c.ordered).every((c) => c.dishId === dishA._id),
    JSON.stringify(r.data.candidates.filter((c) => c.ordered).map((c) => c.name)));
  r = await call('submitVotes', { dishIds: [avail[2]._id], sessionId: 'party' }, 'openid_legacy');
  expect('老数据的老客人可以补投第 1 场', r.ok === true && r.data.session.no === 1, r.msg);

  /* 场次是"归档"而不是"删除"：旧场次的订单还在，能用它查那一场 */
  r = await call('myDinners', {}, V1);
  expect('换场之后，客人仍然能看到并回到旧场次', r.data.dinners.filter((d) => d.no === 1).length === 1);

  /* --- 主人端回看历史场次：点单/点赞按那一场算，食材采购永远按当前这一场 --- */
  const nowSum = (await call('summary', {}, HOST)).data;
  const oldSum = (await call('summary', { sessionId: 'party' }, HOST)).data;
  expect('主人端能回看第 1 场（isCurrent=false + 那一场的序号/名字）',
    oldSum.isCurrent === false && oldSum.session.id === 'party' && oldSum.session.no === 1 && !!oldSum.session.name,
    JSON.stringify(oldSum.session));
  expect('回看第 1 场：点单明细是那一场的份数（×1），不是当前这一场的 ×2',
    (oldSum.orders.filter((o) => o.nick === '老客人')[0] || {}).totalQty === 1,
    JSON.stringify(oldSum.orders.map((o) => o.nick + '×' + o.totalQty)));
  expect('当前这一场（第 2 场）同一人是 ×2（两场的数据确实分开了）',
    (nowSum.orders.filter((o) => o.nick === '老客人')[0] || {}).totalQty === 2,
    JSON.stringify(nowSum.orders.map((o) => o.nick + '×' + o.totalQty)));
  expect('回看历史场次时，食材采购仍然按当前这一场算（买菜是给现在买的）',
    nowSum.ingredientStats.total > 0 && oldSum.ingredientStats.total === nowSum.ingredientStats.total,
    JSON.stringify({ 回看: oldSum.ingredientStats.total, 当前: nowSum.ingredientStats.total }));
  expect('回看历史场次：场次列表照旧带全（好让人接着切）',
    oldSum.sessions.length === nowSum.sessions.length && oldSum.sessions[0].no === 2,
    JSON.stringify(oldSum.sessions.map((s) => s.no + ':' + s.name)));
  // 点赞时没填名字（存的是占位「匿名朋友」）、点单时填了名字的人：
  // 主人端必须看到他点单时那个名字，不能既叫「老客人」又叫「匿名朋友」
  expect('点赞时没填名字的人，用他那一场的点单昵称显示（不显示成匿名朋友）',
    (nowSum.likes.filter((l) => l.dishId === dishA._id)[0] || { who: [] }).who.map((w) => w.name).indexOf('老客人') >= 0,
    JSON.stringify(nowSum.likes.map((l) => l.name + ':' + l.who.map((w) => w.name).join('/'))));
  r = await call('summary', { sessionId: 'party' }, GUEST_C);
  expect('非管理员回看不了任何一场', r.ok === false && /权限/.test(r.msg), r.msg);

  /* --- 主人催票名单：这一场点过单、但还没投票的人 --- */
  await call('submitOrder', { nick: '还没投票的小张', partySize: 1, items: [{ dishId: dishB._id, qty: 1 }] }, 'openid_no_vote_yet');
  r = await call('summary', {}, HOST);
  expect('看板列出「这一场点过单、还没投票的人」（主人催票用）',
    (r.data.likeStats.notVoted || []).indexOf('还没投票的小张') >= 0,
    JSON.stringify(r.data.likeStats.notVoted));
  expect('投过票的人不会出现在催票名单里（老客人投过）',
    (r.data.likeStats.notVoted || []).indexOf('老客人') < 0,
    JSON.stringify(r.data.likeStats.notVoted));
  await call('cancelOrder', {}, 'openid_no_vote_yet');

  /* --- 开席门槛：新开的一场还没人点单时，谁都不能投票 ---
     不然主人一建好下一场，朋友点开就能把下一场的票提前投了。 */
  const cfgRo = state.collections.config.filter((d) => d._id === 'party')[0];
  const keepSession = {
    sessionId: cfgRo.sessionId,
    sessionNo: cfgRo.sessionNo,
    sessionName: cfgRo.sessionName,
    sessionStartedAt: cfgRo.sessionStartedAt
  };
  cfgRo.sessionId = 's_not_started';
  cfgRo.sessionNo = 9;
  cfgRo.sessionName = '还没开席的一场';
  r = await call('votes', {}, V1);
  expect('还没开席的那一场：不发候选、canVote=false',
    r.data.started === false && r.data.canVote === false && r.data.candidates.length === 0,
    JSON.stringify({ started: r.data.started, canVote: r.data.canVote, n: r.data.candidates.length }));
  r = await call('submitVotes', { dishIds: [dishB._id] }, V1);
  expect('还没开席的那一场：投票被拒，并说清为什么',
    r.ok === false && /还没开席/.test(r.msg), r.msg);

  await call('submitOrder', { nick: '先点菜的人', partySize: 2, items: [{ dishId: dishB._id, qty: 1 }] }, 'openid_first_order');
  r = await call('votes', {}, V1);
  expect('有人点单 = 开席：候选回来了', r.data.started === true && r.data.canVote === true && r.data.candidates.length > 0,
    JSON.stringify({ started: r.data.started, canVote: r.data.canVote, n: r.data.candidates.length }));
  r = await call('submitVotes', { dishIds: [dishB._id] }, V1);
  expect('开席之后就能投票了', r.ok === true && r.data.session.no === 9, r.msg + ' ' + JSON.stringify(r.data.session));

  // 那一单又被撤掉 → 这一场重新变成"没开席"，但我的票还在（这就是"误投"的处境）
  await call('cancelOrder', {}, 'openid_first_order');
  r = await call('votes', {}, V1);
  expect('单被撤掉后又回到"没开席"，但我自己的票仍然看得见',
    r.data.started === false && r.data.myVotes.length === 1,
    JSON.stringify({ started: r.data.started, mine: r.data.myVotes }));
  r = await call('submitVotes', { dishIds: [dishA._id] }, V1);
  expect('没开席 + 自己已经有票：允许改（改的是自己那张，不会凭空多出一票）',
    r.ok === true && r.data.count === 1 && r.data.session.no === 9,
    r.msg + ' ' + JSON.stringify(r.data));
  r = await call('votes', {}, V1);
  expect('改完之后仍然是同一张票（没有变成两张）',
    r.data.myVotes.length === 1 && r.data.myVotes[0] === dishA._id, JSON.stringify(r.data.myVotes));
  r = await call('submitVotes', { dishIds: [] }, V1);
  expect('但已经投过的人可以撤掉自己的票（不然连撤都撤不掉）', r.ok === true && r.data.cleared === true, JSON.stringify(r.data));

  // 收尾：把这一场的票清干净、还原当前场次，后面的断言不受影响
  r = await call('resetVotes', { sessionId: 's_not_started' }, HOST);
  expect('这一场的票已经自己撤干净了（再清是 0 条）', r.ok && r.data.cleared === 0 && r.data.sessionId === 's_not_started', JSON.stringify(r.data));
  cfgRo.sessionId = keepSession.sessionId;
  cfgRo.sessionNo = keepSession.sessionNo;
  cfgRo.sessionName = keepSession.sessionName;
  cfgRo.sessionStartedAt = keepSession.sessionStartedAt;
  r = await call('summary', {}, HOST);
  expect('还原当前场次后：又是原来的第 2 场',
    r.data.session.id === keepSession.sessionId && r.data.session.no === 2 && r.data.isCurrent === true,
    JSON.stringify(r.data.session));
  r = await call('votes', {}, V1);
  expect('上面那一通操作没动到第 2 场的票（我这一场的票还在）', r.data.myVotes.length === 1, JSON.stringify(r.data.myVotes));

  /* --- 主人能看到"这道菜是谁赞的" --- */
  // 注意用 dishA/dishB（刚查出来的、确实还在菜库里的菜）：
  // pick3 是很早抓的快照，其中一道中途被删了，而 submitVotes 对不存在的菜是静默丢弃的——
  // 那样投出去的会是空数组，等于"撤销"，测出来的现象会完全误导人。
  const voteA = await call('submitVotes', { dishIds: [dishA._id, dishB._id], nick: '老王' }, V1);
  const voteB = await call('submitVotes', { dishIds: [dishA._id], nick: '小李' }, STRANGER);
  expect('准备数据：两个人各自投上了票',
    voteA.ok && voteA.data.count === 2 && voteB.ok && voteB.data.count === 1,
    JSON.stringify({ a: voteA.data, b: voteB.data, dishA: dishA.name, dishB: dishB.name }));

  r = await call('summary', {}, HOST);
  const liked = r.data.likes.filter((l) => l.dishId === dishA._id)[0];
  expect('主人端点赞榜带出「是谁赞的」',
    !!liked && Array.isArray(liked.who) && liked.who.map((w) => w.name).sort().join(',') === '小李,老王',
    JSON.stringify({ who: liked && liked.who, likes: r.data.likes.map((l) => l.name) }));
  expect('「是谁赞的」里同一个人只出现一次（合并成 ×N）',
    !!liked && liked.who.every((w) => w.count >= 1) &&
      new Set(liked.who.map((w) => w.name)).size === liked.who.length,
    JSON.stringify(liked && liked.who));

  r = await call('board', {}, GUEST_C);
  expect('朋友端拿不到"是谁赞的"（隐私：只给人数，不给名字）',
    r.data.likes.every((l) => l.who === undefined) && JSON.stringify(r.data).indexOf('"who"') < 0,
    JSON.stringify(r.data.likes[0]));
  r = await call('votes', {}, GUEST_C);
  expect('朋友端的点赞接口也不带名字（totals / totalsAll / candidates 都没有）',
    r.data.totals.every((t) => t.who === undefined) &&
      r.data.totalsAll.every((t) => t.who === undefined) &&
      r.data.candidates.every((c) => c.who === undefined) &&
      JSON.stringify(r.data).indexOf('"who"') < 0,
    JSON.stringify(r.data.totals[0]));

  /* 同一个人两场都赞同一道菜：累计榜里合并成 ×2，而不是出现两个同名条目 */
  await call('submitVotes', { dishIds: [dishB._id], nick: '老王', sessionId: 'party' }, V1);
  r = await call('summary', {}, HOST);
  const multi = r.data.likesAll.filter((l) => l.dishId === dishB._id)[0];
  expect('累计榜里同一个人两场都赞 → 合并成一条 ×2',
    !!multi && multi.who.filter((w) => w.name === '老王').length === 1 &&
      multi.who.filter((w) => w.name === '老王')[0].count === 2,
    JSON.stringify(multi && multi.who));

  /* 老点赞记录没存昵称：用"他那一场的点单昵称"兜底 */
  state.collections.votes.push({
    _id: 'legacy_vote_1',
    _openid: V1,
    sessionId: 'party',
    items: [{ dishId: dishB._id, name: dishB.name, emoji: '🍽' }]
  });
  r = await call('summary', {}, HOST);
  const legacyRow = r.data.likesAll.filter((l) => l.dishId === dishB._id)[0];
  expect('老点赞记录（没有昵称）用他那一场的点单昵称兜底，不显示成匿名',
    !!legacyRow && legacyRow.who.some((w) => w.name === '老客人'),
    JSON.stringify(legacyRow && legacyRow.who));

  await call('resetVotes', {}, HOST);

  /* --- 改场次名字（"本次家宴名称"） --- */
  r = await call('renameSession', { name: '0913场家宴' }, GUEST_C);
  expect('非管理员不能改场次名字', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('renameSession', {}, HOST);
  expect('空名字会被拒绝', r.ok === false && /名字/.test(r.msg), r.msg);

  r = await call('renameSession', { name: '0913场家宴' }, HOST);
  expect('改场次名字成功并返回改前改后',
    r.ok && r.data.session.name === '0913场家宴' && r.data.session.no === 2 && r.data.session.current === true && r.data.prev === '中秋家宴',
    JSON.stringify(r.data));
  r = await call('summary', {}, HOST);
  expect('看板上的场次名跟着变', r.data.session.name === '0913场家宴', JSON.stringify(r.data.session));
  expect('场次列表里这一条也改了名（历史那场不受影响）',
    r.data.sessions.filter((s) => s.id === r.data.session.id)[0].name === '0913场家宴' &&
      r.data.sessions.filter((s) => s.no === 1)[0].name === '周六家宴',
    JSON.stringify(r.data.sessions.map((s) => s.no + ':' + s.name)));
  r = await call('votes', { sessionId: 'party' }, V1);
  expect('改名字不会串改历史场次的名字', r.data.session.name === '周六家宴', JSON.stringify(r.data.session));
  r = await call('renameSession', { name: '乱七八糟的名字超过二十个字就会被裁剪掉哦' }, HOST);
  expect('名字超长会被裁剪', r.ok && r.data.session.name.length <= 20, '长度=' + (r.ok ? r.data.session.name.length : '-'));

  /* 有人会直接在云开发控制台改库：只改 config.sessionName，不动 sessions 数组。
     这种情况下看板、场次列表、朋友端的场次标签必须一起变，不能出现"大厅改了、标签还是旧的"。 */
  const cfgDoc = state.collections.config.filter((d) => d._id === 'party')[0];
  cfgDoc.sessionName = '手改的名字';
  r = await call('summary', {}, HOST);
  expect('直接改库（只改 sessionName）：看板与场次列表都用最新名字',
    r.data.session.name === '手改的名字' && r.data.sessions[0].name === '手改的名字',
    JSON.stringify({ now: r.data.session.name, list: r.data.sessions.map((s) => s.name) }));
  r = await call('votes', {}, V1);
  expect('朋友端的场次标签也用最新名字（读的是 config，不是 sessions 存档）',
    r.data.session.name === '手改的名字' && r.data.current.name === '手改的名字',
    JSON.stringify(r.data.session));
  r = await call('myDinners', {}, V1);
  expect('「我参加过的场次」里当前这一场也是新名字',
    r.data.dinners[0].name === '手改的名字' && r.data.dinners[0].current === true,
    JSON.stringify(r.data.dinners.map((d) => d.name)));
  r = await call('renameSession', { name: '0913场家宴' }, HOST);
  expect('改回正式名字', r.ok && r.data.session.name === '0913场家宴');

  /* --- 编辑菜品：临时加的菜能改分类和内容 --- */
  r = await call('addDish', { name: '今天加的自定义菜', category: '自定义', available: true }, HOST);
  const customId = r.data._id;
  expect('新增的菜默认在「自定义」分类', r.ok === true);

  r = await call('updateDish', {
    id: customId,
    patch: {
      name: '油焖大虾',
      category: '贝蟹虾',
      desc: '虾壳煎出红油再焖，汤汁拌饭',
      emoji: '🦐',
      ingredients: ['大虾', '番茄酱', '小葱'],
      tags: ['海鲜', '硬菜']
    }
  }, HOST);
  expect('改菜名/分类/简介/图标/食材/标签都成功', r.ok === true, r.msg);

  r = await call('listDishes', { all: true }, HOST);
  const edited = r.data.dishes.filter((d) => d._id === customId)[0];
  expect('改完之后分类不在「自定义」了', edited.category === '贝蟹虾', JSON.stringify(edited.category));
  expect('内容都落库了',
    edited.name === '油焖大虾' && edited.emoji === '🦐' && edited.desc.indexOf('红油') >= 0 &&
      edited.ingredients.join(',') === '大虾,番茄酱,小葱' && edited.tags.join(',') === '海鲜,硬菜',
    JSON.stringify(edited));
  expect('改内容不会动上架状态和限量',
    edited.available === true && edited.limit === null, JSON.stringify({ available: edited.available, limit: edited.limit }));

  r = await call('updateDish', { id: customId, patch: { name: 'x' } }, GUEST_C);
  expect('非管理员不能改菜品', r.ok === false && /权限/.test(r.msg), r.msg);
  r = await call('updateDish', { id: customId, patch: {} }, HOST);
  expect('空 patch 会被拒绝', r.ok === false && /字段/.test(r.msg), r.msg);
  await call('removeDish', { id: customId }, HOST);
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
    index: ['bootstrap', 'buildShown', 'buildCats', 'dishRow', 'spyCat', 'measureSections', 'onPageScroll', 'onPlus', 'onMinus', 'onNote', 'onSubmit', 'onClearCart', 'reloadMenu', 'onInitAsHost', 'goMenu', 'goDashboard', 'onHide', 'onUnload', 'startDeadlineTick', 'stopDeadlineTick', 'onToggleBoard', 'loadBoard', 'mapBoard', 'onToggleLike', 'loadVotes', 'buildVoteList', 'onTapVote', 'saveVotes', 'bumpLike', 'refreshVoteCounts', 'onClearVotes', 'loadDinners', 'onPickSession', 'onRetry'],
    mine: ['refresh', 'applyOrder', 'onCancel', 'onCopy', 'onBecomeAdmin'],
    menu: ['load', 'buildGroups', 'onToggleDish', 'onToggleCategory', 'batchAll', 'onLimitEdit', 'onImportSeed', 'onFillIngredients', 'onSaveSettings', 'onClearDeadline', 'onToggleDeadline', 'goPantry', 'onShowCoverage', 'onEditDish', 'onEditInput', 'onEditCatChange', 'onCancelEdit', 'onSaveDish'],
    pantry: ['load', 'render', 'putItem', 'onFormInput', 'onCatChange', 'onPickItem', 'onCancelEdit', 'onAdd', 'onRemove', 'onClearAll', 'onToggleQuick', 'onChipFilter', 'onToggleChip', 'onToggleBulk', 'onBulkInput', 'onBulkAdd', 'onRefresh'],
    dashboard: ['load', 'mapOrders', 'mapIngredients', 'mapLikes', 'groupByCat', 'buildMenuText', 'buildDishIngredientText', 'buildShoppingText', 'copyText', 'onCopyMenu', 'onCopyDishIngredient', 'onCopyShopping', 'onToggleIngredient', 'onResetShopping', 'onResetVotes', 'onRenameSession', 'onNewSession', 'previewText', 'onRefresh', 'onShow', 'onHide', 'onUnload', 'startAutoRefresh', 'scheduleRefresh', 'stopAutoRefresh', 'onDropDish', 'onDropOrderItem', 'dropDish', 'onDecItem', 'onEditItemQty', 'setItemQty']
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

  /* ---- 点赞：点一下就生效 / 看板点赞榜 ---- */
  if (loaded.index) {
    expect('点赞页：菜品行上的 👍N 用【跨场次累计】（不然"来过三次都说好"看不出来）',
      loaded.index.dishRow.call({ cart: {}, notes: {}, data: { likeMap: { d1: 9 }, likeMapAll: { d1: 3 } } }, { _id: 'd1', name: '红烧肉' }).likeText === '👍 3' &&
        loaded.index.dishRow.call({ cart: {}, notes: {}, data: { likeMapAll: {} } }, { _id: 'd9', name: '没赞过的菜' }).likeText === '',
      '有人赞显示累计 👍N，没人赞不显示');

    /* 点一下就生效：没有提交按钮，点完立刻发请求 */
    const voteCtx = {
      data: {
        voteCandidates: [
          { dishId: 'd1', name: '红烧肉', emoji: '🍖', qty: 2, ordered: true, likeCount: 3 },
          { dishId: 'd2', name: '拍黄瓜', emoji: '🥒', qty: 1, ordered: true, likeCount: 1 },
          { dishId: 'd3', name: '小米南瓜粥', emoji: '🥣', qty: 0, ordered: false, likeCount: 0 },
          { dishId: 'd4', name: '番茄炒蛋', emoji: '🍅', qty: 0, ordered: false, likeCount: 0 }
        ],
        maxVotes: 3,
        voteSessionId: 'party'
      },
      saved: [],
      setData(d) {
        Object.assign(this.data, d);
      },
      async saveVotes() {
        this.saved.push((this.pickVotes || []).slice());
      },
      loadDinners() {},
      api: { call: () => Promise.resolve({ dishIds: [] }) }
    };
    voteCtx.buildVoteList = loaded.index.buildVoteList;
    voteCtx.onTapVote = loaded.index.onTapVote;
    voteCtx.bumpLike = loaded.index.bumpLike;
    voteCtx.pickVotes = [];

    const tapVote = (id) => voteCtx.onTapVote.call(voteCtx, { currentTarget: { dataset: { id: id } } });

    tapVote('d1');
    tapVote('d2');
    expect('点赞：点一下就立刻保存（不需要按提交）',
      voteCtx.saved.length === 2 && voteCtx.saved[1].join(',') === 'd1,d2' && voteCtx.data.pickCount === 2,
      JSON.stringify(voteCtx.saved));

    tapVote('d1');
    expect('点赞：再点一下是取消，并立刻保存', voteCtx.saved.length === 3 && voteCtx.saved[2].join(',') === 'd2', JSON.stringify(voteCtx.saved[2]));

    tapVote('d1');
    tapVote('d3');
    expect('点赞：选满 3 道', voteCtx.data.pickCount === 3 && voteCtx.saved[4].length === 3, JSON.stringify(voteCtx.saved[4]));
    tapVote('d4');
    expect('点赞：第 4 道点不动，也不会发请求',
      voteCtx.data.pickCount === 3 && voteCtx.saved.length === 5 && voteCtx.data.voteList[3].picked === false,
      '请求数=' + voteCtx.saved.length);

    expect('点赞：自己刚投的那一票立刻算进"几人赞"（不用等后台）',
      voteCtx.data.voteList[0].likeCount === 4 && voteCtx.data.voteList[1].likeCount === 2,
      JSON.stringify(voteCtx.data.voteList.map((v) => v.name + ':' + v.likeCount)));

    // 保存失败要回滚，不能让界面骗人（页面里用的是同一个 api 模块对象，直接把它打成永远失败）
    const voteApi = require(path.join(ROOT, 'miniprogram', 'utils', 'api.js'));
    const realVoteCall = voteApi.call;
    voteApi.call = () => Promise.reject(new Error('网络异常'));
    const failCtx = {
      data: { voteCandidates: [{ dishId: 'd1', name: '红烧肉', likeCount: 0 }], maxVotes: 3, voteSessionId: 'party' },
      setData(d) {
        Object.assign(this.data, d);
      },
      _serverVotes: [],
      loadDinners() {},
      toastErr() {},
      refreshVoteCounts() {},
      myNick() {
        return '老王';
      }
    };
    failCtx.buildVoteList = loaded.index.buildVoteList;
    failCtx.onTapVote = loaded.index.onTapVote;
    failCtx.bumpLike = loaded.index.bumpLike;
    failCtx.saveVotes = loaded.index.saveVotes;
    failCtx.pickVotes = [];
    try {
      failCtx.onTapVote.call(failCtx, { currentTarget: { dataset: { id: 'd1' } } });
      await new Promise((r) => setTimeout(r, 30));
      expect('点赞：保存失败会回滚本地勾选，并给出错误提示',
        failCtx.pickVotes.length === 0 && failCtx.data.pickCount === 0 && failCtx.data.voteHintBad === true,
        JSON.stringify({ pick: failCtx.pickVotes, hint: failCtx.data.voteHint, bad: failCtx.data.voteHintBad }));
    } finally {
      voteApi.call = realVoteCall;
    }

    /* 场次切换：把某一场的票读回来 */
    const pickCtx = {
      data: { voteSessionId: 'party', voteCandidates: [] },
      calls: [],
      setData(d) {
        Object.assign(this.data, d);
      },
      async loadVotes(silent, id) {
        this.calls.push({ silent: silent, id: id });
      }
    };
    pickCtx.onPickSession = loaded.index.onPickSession;
    pickCtx.buildVoteList = loaded.index.buildVoteList;
    pickCtx.onPickSession.call(pickCtx, { currentTarget: { dataset: { id: 'party' } } });
    expect('点赞页：点自己已经选中的那一场不做任何请求', pickCtx.calls.length === 0);
    pickCtx.onPickSession.call(pickCtx, { currentTarget: { dataset: { id: 's2' } } });
    expect('点赞页：切到另一场会带上 sessionId 重新拉票',
      pickCtx.calls.length === 1 && pickCtx.calls[0].id === 's2' && pickCtx.calls[0].silent === true,
      JSON.stringify(pickCtx.calls));

    /* 场次标签的数据映射：拿**真实的 myDinners 返回**过一遍 ——
       接口里字段叫 id、模板里用 sessionId，这一层不映射就会出现"标签点不动"
       （名字显示得出来，但 data-id 是空的，点了什么都不发生）。 */
    const dinnerRes = await call('myDinners', {}, 'openid_repeat_guest'); // 上面那位两场都露过面的客人
    const dinnerVm = loaded.index.mapDinners(dinnerRes.data.dinners);
    expect('点赞页：场次标签的 id 映射没丢（接口的 id → 模板用的 sessionId）',
      dinnerRes.data.dinners.length === 2 &&
        dinnerVm.every((d) => !!d.sessionId) &&
        dinnerVm.map((d) => d.sessionId).join() === dinnerRes.data.dinners.map((d) => d.id).join(),
      JSON.stringify({ 接口: dinnerRes.data.dinners.map((d) => d.id), 标签: dinnerVm.map((d) => d.sessionId) }));
    expect('点赞页：每个场次标签的 key 都唯一（不能全是 undefined）',
      new Set(dinnerVm.map((d) => d.sessionId)).size === dinnerVm.length,
      JSON.stringify(dinnerVm.map((d) => d.sessionId)));
    expect('点赞页：标签里既有历史那场、也有"进行中"那一场',
      dinnerVm.some((d) => d.sessionId === 'party') && dinnerVm.filter((d) => d.current).length === 1,
      JSON.stringify(dinnerVm.map((d) => d.sessionId + (d.current ? '(进行中)' : ''))));
    expect('点赞页：标签的字段一个都没丢（id/no/name/current/voted 照原样过来）',
      dinnerVm.map((d) => [d.sessionId, d.no, d.name, d.current, d.voted].join('|')).join() ===
        dinnerRes.data.dinners.map((d) => [d.id, d.no, d.name, !!d.current, !!d.voted].join('|')).join(),
      JSON.stringify({ 接口: dinnerRes.data.dinners, 标签: dinnerVm }));

    /* 真的点一下那个历史场次的标签：要带着 party 去拉那一场的票 */
    const chipCtx = {
      data: { voteSessionId: dinnerVm.filter((d) => d.current)[0].sessionId, voteCandidates: [] },
      calls: [],
      setData(d) {
        Object.assign(this.data, d);
      },
      async loadVotes(silent, id) {
        this.calls.push({ silent: silent, id: id });
      }
    };
    chipCtx.onPickSession = loaded.index.onPickSession;
    chipCtx.onPickSession.call(chipCtx, { currentTarget: { dataset: { id: 'party' } } });
    expect('点赞页：点「历史那一场」的标签 → 真的带 sessionId=party 去拉票',
      chipCtx.calls.length === 1 && chipCtx.calls[0].id === 'party',
      JSON.stringify(chipCtx.calls));
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

  /* 真机网络不稳时：云函数调用既不 success 也不 fail 也不能永远转圈 */
  {
    const apiUtil = require(path.join(ROOT, 'miniprogram', 'utils', 'api.js'));
    const savedCloud = global.wx.cloud;
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;

    global.wx.cloud = { init() {}, callFunction() { /* 故意谁都不回调 */ } };
    // 把定时器换成"立即触发"，这样不用真等 20 秒
    global.setTimeout = function (fn) {
      realSetTimeout(fn, 0);
      return 0;
    };
    global.clearTimeout = function () {};

    try {
      await apiUtil.call('whoami');
      bad('云函数悬着不回调时应该有超时兜底', '居然 resolve 了');
    } catch (e) {
      expect('云函数悬着不回调 → 20 秒超时兜底，给出能照做的提示', /超时/.test(e.message), e.message);
    } finally {
      global.wx.cloud = savedCloud;
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }

    // 重复回调（success 之后再 fail）不能把已经 resolve 的结果改掉，也不能报错
    global.wx.cloud = {
      init() {},
      callFunction(opts) {
        opts.success({ result: { ok: true, data: { openid: 'x' } } });
        opts.fail({ errMsg: 'boom' });
        opts.success({ result: { ok: false, msg: 'late' } });
      }
    };
    try {
      const data = await apiUtil.call('whoami');
      expect('云函数重复回调只认第一个（不会反复 resolve/reject）', data.openid === 'x', JSON.stringify(data));
    } catch (e) {
      bad('云函数重复回调只认第一个', e.message);
    } finally {
      global.wx.cloud = savedCloud;
    }
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
