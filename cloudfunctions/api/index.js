/**
 * 家宴点菜 · 唯一云函数（action 路由）
 *
 * 为什么要"一个云函数"：部署时只需要右键上传一个函数，
 * 不用逐个部署 6 个函数，减少出错点。
 *
 * 数据库集合：dishes（菜库）、orders（点单）、config（家宴配置）、votes（点赞）
 * 全部读写都走云函数，因此**不需要在云开发控制台配置任何集合权限**。
 *
 * 家里的「库存」（有哪些食材/调料）也存在 config 文档的 pantry 字段里，
 * 不单独开集合：省得再建一个集合，而且库存天然是"一份"而不是"很多条记录"。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = ['dishes', 'orders', 'config', 'votes'];
const PARTY_ID = 'party';
const MAX_LIMIT = 500;

/** 每人最多给几道菜点赞 */
const MAX_VOTES = 3;

/** 库存分类：固定三种，前端筛选/分组都按这个顺序 */
const PANTRY_CATS = ['食材', '调料', '其他'];
const MAX_PANTRY = 300;

/* ------------------------------ 工具 ------------------------------ */

const ok = (data) => ({ ok: true, data: data === undefined ? null : data });
const fail = (msg) => ({ ok: false, msg });

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function int(v, def, min, max) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function str(v, maxLen) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, maxLen);
}

/** 创建集合（已存在会抛错，忽略即可） */
async function ensureCollections() {
  const created = [];
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (e) {
      /* 已存在 */
    }
  }
  return created;
}

/** 集合不存在（-502005）还是别的错？ */
function isCollectionMissing(e) {
  if (!e) return false;
  const code = String(e.errCode === undefined || e.errCode === null ? '' : e.errCode);
  const msg = String(e.errMsg || e.message || '');
  return code === '-502005' || /collection not exists|COLLECTION_NOT_EXIST/i.test(msg);
}

/**
 * 集合不存在就补建一次再重试。
 *
 * 为什么需要：votes 是后来才加的集合，**老环境里没有**——而 ensureCollections 只在
 * 「开通家宴」（init）时跑一次，已经初始化过的环境不会重新执行它。
 * 不兜住的话，老环境里第一次点赞会直接报「collection not exists」。
 */
async function withCollection(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
    try {
      await db.createCollection(name);
    } catch (e2) {
      /* 并发下可能已被创建，忽略 */
    }
    return await fn();
  }
}

async function getConfig() {
  try {
    const res = await db.collection('config').doc(PARTY_ID).get();
    return res.data || null;
  } catch (e) {
    return null;
  }
}

/**
 * 写家宴配置（单文档 'party'）。
 *
 * ⚠️ 这里刻意不依赖「doc().update() 在文档不存在时会不会抛错」：
 * 云开发 SDK 的行为并不一致——有的抛错，有的只返回 stats.updated = 0（静默失败）。
 * 早期版本按"一定抛错"写，导致第一次初始化时创建分支根本走不到，
 * 配置没落库，紧接着读回来是 null，就崩在 cfg.admins 上了。
 * 所以改成：先看文档在不在，再决定 update 还是 set（set 语义是"不存在则创建"）。
 */
async function saveConfig(cfg) {
  const data = Object.assign({}, cfg);
  delete data._id;

  const existed = !!(await getConfig());

  if (existed) {
    try {
      const res = await db.collection('config').doc(PARTY_ID).update({ data });
      const updated = res && res.stats ? Number(res.stats.updated) || 0 : 0;
      if (updated > 0) return true;
    } catch (e) {
      /* 更新失败就落到下面重建 */
    }
  }

  // set：不存在则创建，存在则替换。这是这里最不容易出错的一步。
  try {
    await db.collection('config').doc(PARTY_ID).set({ data });
    return true;
  } catch (e) {
    /* 个别环境 set 不可用，退回 add（部分 SDK 允许显式指定 _id） */
  }

  await db.collection('config').add({ data: Object.assign({ _id: PARTY_ID }, data) });
  return true;
}

function defaultConfig(hostCode) {
  return {
    title: '周末家宴',
    host: '主人',
    address: '',
    notice: '想吃什么点什么，记得写忌口～',
    deadlineTs: 0, // 0 = 不限制截止时间
    maxDishesPerOrder: 0, // 0 = 不限制每人点几道
    // 食材采购勾选：{ 食材名: true }。只存"已采购"的，没勾的就是还缺的
    shopping: {},
    // 家里囤货：{ 名称: { cat, qty, note } }。跟菜谱无关，纯"我家有什么"
    pantry: {},
    hostCode: hostCode || randomCode(),
    admins: []
  };
}

/** 对外暴露的配置：非管理员看不到主人口令 */
function publicConfig(cfg, isAdmin) {
  if (!cfg) return null;
  const out = {
    title: cfg.title || '周末家宴',
    host: cfg.host || '主人',
    address: cfg.address || '',
    notice: cfg.notice || '',
    deadlineTs: Number(cfg.deadlineTs) || 0,
    maxDishesPerOrder: Number(cfg.maxDishesPerOrder) || 0
  };
  if (isAdmin) out.hostCode = cfg.hostCode || '';
  return out;
}

function isAdminOf(cfg, openid) {
  return !!cfg && (cfg.admins || []).indexOf(openid) >= 0;
}

async function requireAdmin(openid) {
  const cfg = await getConfig();
  if (!cfg) throw new Error('家宴还没初始化，请先在「我的」页用主人口令初始化');
  if (!isAdminOf(cfg, openid)) throw new Error('没有主人权限');
  return cfg;
}

function normalizeDishItem(it) {
  return {
    dishId: str(it && it.dishId, 64),
    name: str(it && it.name, 30),
    emoji: str(it && it.emoji, 8),
    qty: int(it && it.qty, 0, 0, 99),
    note: str(it && it.note, 60)
  };
}

/* ------------------------------ 各 action ------------------------------ */

/** 初始化：创建集合；首位调用者成为主人；之后需口令才能成为管理员 */
async function handleInit(openid, event) {
  await ensureCollections();
  let cfg = await getConfig();
  let justCreated = false;

  if (!cfg) {
    const fresh = defaultConfig(event.hostCode);
    fresh.admins = [];
    await saveConfig(fresh);
    // 再读一次确认；即使读不到（刚写完的读一致性 / 权限问题）也不能崩：
    // 用内存里这份继续，下一次调用以数据库为准
    cfg = (await getConfig()) || Object.assign({ _id: PARTY_ID }, fresh);
    justCreated = true;
  }

  if (isAdminOf(cfg, openid)) {
    return ok({ openid, isAdmin: true, inited: true, config: publicConfig(cfg, true) });
  }

  // 刚刚由这次调用创建家宴的人，直接成为主人（不需要再输口令）
  if (justCreated) {
    cfg.admins = (cfg.admins || []).concat([openid]);
    await saveConfig(cfg);
    return ok({ openid, isAdmin: true, inited: true, config: publicConfig(cfg, true) });
  }

  // 自愈：配置存在但一个管理员都没有（比如上一次初始化中途失败留下的半成品），
  // 这种状态下谁也进不来、口令也没人知道，所以允许第一个到达的人认领
  if (!cfg.admins || !cfg.admins.length) {
    cfg.admins = [openid];
    await saveConfig(cfg);
    return ok({ openid, isAdmin: true, inited: true, config: publicConfig(cfg, true) });
  }

  const code = str(event.hostCode, 20);
  if (!code || code !== String(cfg.hostCode || '')) {
    return fail('主人口令不正确');
  }
  cfg.admins = (cfg.admins || []).concat([openid]);
  await saveConfig(cfg);
  return ok({ openid, isAdmin: true, inited: true, config: publicConfig(cfg, true) });
}

async function handleWhoami(openid) {
  const cfg = await getConfig();
  if (!cfg) return ok({ openid, isAdmin: false, inited: false, config: null });
  const isAdmin = isAdminOf(cfg, openid);
  return ok({ openid, isAdmin, inited: true, config: publicConfig(cfg, isAdmin) });
}

/** 朋友端只看 available 的菜；主人端（all=true）看全部菜库 */
async function handleListDishes(openid, event) {
  const cfg = await getConfig();
  const isAdmin = isAdminOf(cfg, openid);
  const wantAll = !!event.all && isAdmin;

  let query = db.collection('dishes');
  if (!wantAll) query = query.where({ available: true });

  const res = await query.orderBy('sort', 'asc').limit(MAX_LIMIT).get();
  const dishes = (res.data || []).map((d) => ({
    _id: d._id,
    name: d.name,
    category: d.category || '其他',
    desc: d.desc || '',
    emoji: d.emoji || '🍽',
    limit: d.limit === null || d.limit === undefined ? null : Number(d.limit),
    tags: d.tags || [],
    ingredients: d.ingredients || [],
    sort: Number(d.sort) || 0,
    available: !!d.available
  }));
  return ok({ dishes, isAdmin });
}

/**
 * 批量导入菜库
 *  默认            只补新增（不覆盖主人已经改过的菜）
 *  overwrite: true 同名菜整体覆盖（会把上架状态也还原成种子里的）
 *  ingredientsOnly 只给已有菜补 ingredients（上架状态、限量、自定义描述都不动）
 */
async function handleSeedDishes(openid, event) {
  await requireAdmin(openid);
  const list = Array.isArray(event.dishes) ? event.dishes.slice(0, 200) : [];
  if (!list.length) throw new Error('没有可导入的菜品');
  const overwrite = !!event.overwrite;
  let ingredientsFilled = 0;

  const existing = await db.collection('dishes').limit(MAX_LIMIT).get();
  const byName = {};
  (existing.data || []).forEach((d) => {
    byName[d.name] = d;
  });

  const toAdd = [];
  const toUpdate = [];

  for (const raw of list) {
    const name = str(raw && raw.name, 30);
    if (!name) continue;
    const data = {
      name,
      category: str(raw.category, 12) || '其他',
      desc: str(raw.desc, 60),
      emoji: str(raw.emoji, 8) || '🍽',
      limit: raw.limit === null || raw.limit === undefined ? null : int(raw.limit, null, 1, 99),
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 5).map((t) => str(t, 10)) : [],
      ingredients: Array.isArray(raw.ingredients) ? raw.ingredients.slice(0, 10).map((t) => str(t, 12)) : [],
      sort: int(raw.sort, 0, 0, 9999),
      available: !!raw.available
    };
    const hit = byName[name];
    if (!hit) toAdd.push(data);
    else if (overwrite) toUpdate.push({ id: hit._id, data });
    else if (event.ingredientsOnly) {
      // 只补食材：不动你的上架状态、限量、自定义描述
      toUpdate.push({ id: hit._id, data: { ingredients: data.ingredients } });
      ingredientsFilled += 1;
    }
  }

  // 并发写入：36 道菜不要串行 36 次，否则容易撞上云函数默认超时
  const chunk = async (arr, size, worker) => {
    for (let i = 0; i < arr.length; i += size) {
      await Promise.all(arr.slice(i, i + size).map(worker));
    }
  };

  await chunk(toAdd, 10, (data) => db.collection('dishes').add({ data }));
  await chunk(toUpdate, 10, (item) => db.collection('dishes').doc(item.id).update({ data: item.data }));

  return ok({ added: toAdd.length, updated: toUpdate.length, ingredientsFilled: ingredientsFilled, total: list.length });
}

async function handleToggleDish(openid, event) {
  await requireAdmin(openid);
  const id = str(event.id, 64);
  if (!id) throw new Error('缺少菜品 id');
  await db.collection('dishes').doc(id).update({ data: { available: !!event.available } });
  return ok({ id, available: !!event.available });
}

/** 批量上架 / 下架：传 ids 则只改这些，不传则改全部 */
async function handleBatchToggle(openid, event) {
  await requireAdmin(openid);
  const available = !!event.available;
  const ids = Array.isArray(event.ids) ? event.ids.slice(0, 200) : null;

  let res;
  if (ids && ids.length) {
    res = await db.collection('dishes').where({ _id: _.in(ids) }).update({ data: { available } });
  } else {
    res = await db.collection('dishes').where({ available: _.neq(available) }).update({ data: { available } });
  }
  const updated = res && res.stats ? Number(res.stats.updated) || 0 : 0;
  return ok({ updated, available });
}

async function handleUpdateDish(openid, event) {
  await requireAdmin(openid);
  const id = str(event.id, 64);
  if (!id) throw new Error('缺少菜品 id');
  const patch = event.patch || {};
  const data = {};
  if (patch.name !== undefined) data.name = str(patch.name, 30);
  if (patch.category !== undefined) data.category = str(patch.category, 12) || '其他';
  if (patch.desc !== undefined) data.desc = str(patch.desc, 60);
  if (patch.emoji !== undefined) data.emoji = str(patch.emoji, 8) || '🍽';
  if (patch.limit !== undefined) {
    data.limit = patch.limit === null || patch.limit === '' ? null : int(patch.limit, null, 1, 99);
  }
  if (patch.sort !== undefined) data.sort = int(patch.sort, 0, 0, 9999);
  if (patch.available !== undefined) data.available = !!patch.available;
  if (patch.tags !== undefined && Array.isArray(patch.tags)) {
    data.tags = patch.tags.slice(0, 5).map((t) => str(t, 10));
  }
  if (patch.ingredients !== undefined && Array.isArray(patch.ingredients)) {
    data.ingredients = patch.ingredients.slice(0, 10).map((t) => str(t, 12));
  }
  if (!Object.keys(data).length) throw new Error('没有可更新的字段');
  await db.collection('dishes').doc(id).update({ data });
  return ok(data);
}

async function handleAddDish(openid, event) {
  await requireAdmin(openid);
  const name = str(event.name, 30);
  if (!name) throw new Error('菜名不能为空');
  const res = await db.collection('dishes').add({
    data: {
      name,
      category: str(event.category, 12) || '其他',
      desc: str(event.desc, 60),
      emoji: str(event.emoji, 8) || '🍽',
      limit: event.limit === null || event.limit === undefined || event.limit === '' ? null : int(event.limit, null, 1, 99),
      tags: Array.isArray(event.tags) ? event.tags.slice(0, 5).map((t) => str(t, 10)) : [],
      ingredients: Array.isArray(event.ingredients) ? event.ingredients.slice(0, 10).map((t) => str(t, 12)) : [],
      sort: int(event.sort, 999, 0, 9999),
      available: event.available === undefined ? true : !!event.available
    }
  });
  return ok({ _id: res._id });
}

async function handleRemoveDish(openid, event) {
  await requireAdmin(openid);
  const id = str(event.id, 64);
  if (!id) throw new Error('缺少菜品 id');
  await db.collection('dishes').doc(id).remove();
  return ok({ id });
}

async function handleUpdateConfig(openid, event) {
  const cfg = await requireAdmin(openid);
  const patch = event.patch || {};
  const data = {};
  if (patch.title !== undefined) data.title = str(patch.title, 30) || '家宴';
  if (patch.host !== undefined) data.host = str(patch.host, 20);
  if (patch.address !== undefined) data.address = str(patch.address, 60);
  if (patch.notice !== undefined) data.notice = str(patch.notice, 100);
  if (patch.deadlineTs !== undefined) data.deadlineTs = int(patch.deadlineTs, 0, 0, 4102444800000);
  if (patch.maxDishesPerOrder !== undefined) data.maxDishesPerOrder = int(patch.maxDishesPerOrder, 0, 0, 99);
  if (!Object.keys(data).length) return ok(publicConfig(cfg, true));
  const merged = Object.assign({}, cfg, data);
  await saveConfig(merged);
  return ok(publicConfig(merged, true));
}

/** 下单 / 改单（每人一单，重复提交即覆盖自己的单） */
async function handleSubmitOrder(openid, event) {
  const cfg = await getConfig();
  if (!cfg) throw new Error('家宴还没初始化，请等主人开通');

  const deadlineTs = Number(cfg.deadlineTs) || 0;
  if (deadlineTs && Date.now() > deadlineTs) throw new Error('点单已经截止啦');

  const items = (Array.isArray(event.items) ? event.items : [])
    .map(normalizeDishItem)
    .filter((it) => it.dishId && it.qty > 0);
  if (!items.length) throw new Error('至少点一道菜');

  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const maxDishes = Number(cfg.maxDishesPerOrder) || 0;
  if (maxDishes > 0 && totalQty > maxDishes) {
    throw new Error('每单最多点 ' + maxDishes + ' 道菜');
  }

  // 校验菜品存在 / 已上架
  const ids = items.map((i) => i.dishId);
  const dishRes = await db.collection('dishes').where({ _id: _.in(ids) }).limit(MAX_LIMIT).get();
  const dishMap = {};
  (dishRes.data || []).forEach((d) => {
    dishMap[d._id] = d;
  });

  // 别人已经点掉的份数（用于限量校验）
  const orderRes = await db.collection('orders').limit(MAX_LIMIT).get();
  const usedByOthers = {};
  (orderRes.data || []).forEach((o) => {
    if (o._openid === openid) return;
    (o.items || []).forEach((i) => {
      usedByOthers[i.dishId] = (usedByOthers[i.dishId] || 0) + (Number(i.qty) || 0);
    });
  });

  for (const it of items) {
    const dish = dishMap[it.dishId];
    if (!dish) throw new Error('菜品不存在：' + (it.name || it.dishId));
    if (!dish.available) throw new Error(dish.name + ' 已经下架了');
    const limit = dish.limit === null || dish.limit === undefined ? 0 : Number(dish.limit);
    if (limit > 0) {
      const used = usedByOthers[it.dishId] || 0;
      if (used + it.qty > limit) {
        const left = Math.max(0, limit - used);
        throw new Error(dish.name + (left > 0 ? ' 只剩 ' + left + ' 份了' : ' 已经被点完了'));
      }
    }
    it.name = dish.name;
    it.emoji = dish.emoji || '🍽';
  }

  const doc = {
    _openid: openid,
    nick: str(event.nick, 20) || '匿名朋友',
    partySize: int(event.partySize, 1, 1, 50),
    arriveAt: str(event.arriveAt, 20),
    note: str(event.note, 100),
    items,
    totalQty,
    // 朋友这次提交之后，之前"主人调整过你的点单"的提醒就算看过了
    hostNote: '',
    updatedAt: db.serverDate()
  };

  const mine = await db.collection('orders').where({ _openid: openid }).limit(1).get();
  if (mine.data && mine.data.length) {
    const id = mine.data[0]._id;
    await db.collection('orders').doc(id).update({ data: doc });
    return ok({ orderId: id, updated: true });
  }
  doc.createdAt = db.serverDate();
  const added = await db.collection('orders').add({ data: doc });
  return ok({ orderId: added._id, updated: false });
}

async function handleMyOrder(openid) {
  const res = await db.collection('orders').where({ _openid: openid }).limit(1).get();
  const order = (res.data && res.data[0]) || null;
  if (order) delete order._openid;
  return ok({ order });
}

async function handleCancelOrder(openid) {
  const res = await db.collection('orders').where({ _openid: openid }).limit(1).get();
  if (res.data && res.data.length) {
    await db.collection('orders').doc(res.data[0]._id).remove();
  }
  return ok({ removed: true });
}

/**
 * 把订单聚合成汇总数据。后厨看板（仅主人）和朋友端的"大家都在点什么"共用这一份逻辑，
 * 差别只在 withOrderId：订单 id 只给主人端，朋友端拿不到（去掉菜品的接口本来也要口令，
 * 但没必要把内部 id 发给所有人）。
 */
function aggregateOrders(cfg, orderDocs, dishDocs, withOrderId, likeMap) {
  const orders = (orderDocs || []).map((o) => {
    const one = {
      nick: o.nick || '匿名朋友',
      partySize: Number(o.partySize) || 1,
      arriveAt: o.arriveAt || '',
      note: o.note || '',
      items: o.items || [],
      totalQty: Number(o.totalQty) || 0,
      // 标记「这条是主人自己下的单」：主人自测后忘了撤销的话，
      // 人数/份数会偏多，看板上必须能一眼看出来
      isHost: (cfg.admins || []).indexOf(o._openid) >= 0
    };
    if (withOrderId) one.orderId = o._id; // 主人端要能针对"某一单"调整
    return one;
  });

  const dishMap = {};
  (dishDocs || []).forEach((d) => {
    dishMap[d._id] = d;
  });

  const totals = {};
  orders.forEach((o) => {
    o.items.forEach((i) => {
      if (!totals[i.dishId]) {
        const dish = dishMap[i.dishId] || {};
        totals[i.dishId] = {
          dishId: i.dishId,
          name: i.name || dish.name || '已删除的菜',
          emoji: i.emoji || dish.emoji || '🍽',
          category: dish.category || '其他',
          limit: dish.limit === null || dish.limit === undefined ? null : Number(dish.limit),
          // 菜自己的食材：导出"菜 + 食材"清单要用
          ingredients: dish.ingredients || [],
          qty: 0,
          guests: [],
          notes: []
        };
      }
      totals[i.dishId].qty += Number(i.qty) || 0;
      if (totals[i.dishId].guests.indexOf(o.nick) < 0) totals[i.dishId].guests.push(o.nick);
      if (i.note) totals[i.dishId].notes.push(o.nick + '：' + i.note);
    });
  });

  const dishTotals = Object.keys(totals)
    .map((k) => totals[k])
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));

  // 每道菜带上"多少人点赞"（没有点赞记录就是 0，不是 undefined，前端不用再判空）
  dishTotals.forEach((t) => {
    t.likeCount = (likeMap && likeMap[t.dishId]) || 0;
  });

  return {
    orders,
    dishTotals,
    stats: {
      orderCount: orders.length,
      totalPeople: orders.reduce((s, o) => s + o.partySize, 0),
      totalDishes: orders.reduce((s, o) => s + o.totalQty, 0),
      dishKindCount: dishTotals.length
    }
  };
}

/**
 * 今晚要做的菜涉及的食材清单（含"是否已采购"和"家里有没有"）
 *
 * 取菜范围 = 已上架的菜 ∪ 订单里出现过的菜。
 * 之所以连"已点但已被下架"的也算进来：那些菜朋友确实点了，主人可能还是会做。
 *
 * pantry（家里囤货）只用来**标记**，不会把食材从清单里删掉——
 * 清单是"这次家宴要用到什么"，家里有没有是另一回事，标出来才能一眼看出少什么。
 */
function buildIngredients(dishDocs, orderDocs, shopping, pantry) {
  const wanted = {};
  (dishDocs || []).forEach((d) => {
    if (d.available) wanted[d._id] = true;
  });
  (orderDocs || []).forEach((o) => {
    (o.items || []).forEach((i) => {
      wanted[i.dishId] = true;
    });
  });

  const list = [];
  const index = {};
  (dishDocs || []).forEach((d) => {
    if (!wanted[d._id]) return;
    (d.ingredients || []).forEach((raw) => {
      const name = String(raw || '').trim();
      if (!name) return;
      if (!index[name]) {
        index[name] = {
          name: name,
          dishes: [],
          purchased: !!(shopping && shopping[name]),
          inStock: !!(pantry && pantry[name])
        };
        list.push(index[name]);
      }
      if (index[name].dishes.indexOf(d.name) < 0) index[name].dishes.push(d.name);
    });
  });

  // 排序：要买的排最前（买菜先看缺的）→ 已采购的 → 家里本来就有的排最后
  const rank = (i) => (i.inStock ? 2 : i.purchased ? 1 : 0);
  return list.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/* ------------------------------ 库存（家里有什么） ------------------------------ */

function pantryCat(v) {
  const c = str(v, 6);
  return PANTRY_CATS.indexOf(c) >= 0 ? c : '食材';
}

/** 单条库存的字段清洗；名称为空视为无效条目（返回 null） */
function normalizePantryItem(raw) {
  const name = str(raw && raw.name, 20);
  if (!name) return null;
  return {
    name: name,
    cat: pantryCat(raw && raw.cat),
    qty: str(raw && raw.qty, 12),
    note: str(raw && raw.note, 20)
  };
}

/** 库存对象 → 排好序的数组（食材 → 调料 → 其他，同类按名字） */
function pantryList(cfg) {
  const map = (cfg && cfg.pantry) || {};
  const items = Object.keys(map).map((name) => {
    const it = map[name] || {};
    return { name: name, cat: pantryCat(it.cat), qty: str(it.qty, 12), note: str(it.note, 20) };
  });
  items.sort((a, b) => {
    const ca = PANTRY_CATS.indexOf(a.cat);
    const cb = PANTRY_CATS.indexOf(b.cat);
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  });
  return items;
}

function pantryStats(items) {
  const s = { total: items.length, food: 0, seasoning: 0, other: 0 };
  items.forEach((i) => {
    if (i.cat === '调料') s.seasoning += 1;
    else if (i.cat === '其他') s.other += 1;
    else s.food += 1;
  });
  return s;
}

/** 家里的库存清单（仅主人：朋友不该看到你家冰箱里有什么） */
async function handleListPantry(openid) {
  const cfg = await requireAdmin(openid);
  const items = pantryList(cfg);
  return ok({ items: items, stats: pantryStats(items) });
}

/**
 * 新增 / 更新库存条目（可批量）
 *   { items: [{ name, cat, qty, note }, ...] }   批量
 *   { name, cat, qty, note }                     单条
 * 同名视为"更新"，不产生重复条目。
 *
 * 更新时的字段语义：**没传的字段保持不变，传了空字符串才是清空**。
 * 这样「快速点选」这类只带名字的调用不会把已有的数量/备注抹掉，
 * 而库存页的编辑表单（每个字段都会传）依然能正常清空。
 */
async function handleSavePantryItems(openid, event) {
  const cfg = await requireAdmin(openid);
  const raw = Array.isArray(event.items) ? event.items.slice(0, 200) : [event];
  const pantry = Object.assign({}, cfg.pantry || {});
  let added = 0;
  let updated = 0;
  const names = [];

  for (const r of raw) {
    const item = normalizePantryItem(r);
    if (!item) continue;

    const has = (k) => !!r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, k);
    const old = pantry[item.name];
    const next = {
      cat: has('cat') || !old ? item.cat : pantryCat(old.cat),
      qty: has('qty') || !old ? item.qty : str(old.qty, 12),
      note: has('note') || !old ? item.note : str(old.note, 20)
    };

    if (old) updated += 1;
    else added += 1;
    pantry[item.name] = next;
    names.push(item.name);
  }

  if (!names.length) throw new Error('没有可保存的条目（名称不能为空）');
  const total = Object.keys(pantry).length;
  if (total > MAX_PANTRY) throw new Error('库存最多存 ' + MAX_PANTRY + ' 项，先清理一些吧');

  await saveConfig(Object.assign({}, cfg, { pantry: pantry }));
  return ok({ saved: names.length, added: added, updated: updated, total: total, names: names });
}

/** 删掉一条库存 */
async function handleRemovePantryItem(openid, event) {
  const cfg = await requireAdmin(openid);
  const name = str(event.name, 20);
  if (!name) throw new Error('缺少名称');
  const pantry = Object.assign({}, cfg.pantry || {});
  const existed = !!pantry[name];
  delete pantry[name];
  await saveConfig(Object.assign({}, cfg, { pantry: pantry }));
  return ok({ name: name, removed: existed, total: Object.keys(pantry).length });
}

/** 清空库存（换季大扫除用；不影响菜库和订单） */
async function handleClearPantry(openid) {
  const cfg = await requireAdmin(openid);
  const cleared = Object.keys(cfg.pantry || {}).length;
  await saveConfig(Object.assign({}, cfg, { pantry: {} }));
  return ok({ cleared: cleared });
}

/* ------------------------------ 点赞（这道菜好不好吃） ------------------------------ */

/**
 * 读全部投票。
 * 集合还不存在（老环境没建过 votes）时当作「还没人投票」，而不是报错——
 * 买菜清单、后厨看板都不该因为一个附加功能没建集合就整页挂掉。
 */
async function readVotes() {
  try {
    const res = await db.collection('votes').limit(MAX_LIMIT).get();
    return res.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) return [];
    throw e;
  }
}

/**
 * 点赞汇总 → [{ dishId, name, emoji, count }]，按人数降序。
 *
 * 一人一份票（重复提交即覆盖自己的），所以 count 就是「有多少人推荐这道菜」，
 * 同一个人反复来吃也不会把票数刷上去——这比累计历史点赞更适合当"下次点什么"的参考。
 */
function buildLikeTotals(voteDocs, dishDocs) {
  const dishMap = {};
  (dishDocs || []).forEach((d) => {
    dishMap[d._id] = d;
  });

  const index = {};
  (voteDocs || []).forEach((v) => {
    (v.items || []).forEach((it) => {
      if (!it || !it.dishId) return;
      if (!index[it.dishId]) {
        const dish = dishMap[it.dishId] || {};
        index[it.dishId] = {
          dishId: it.dishId,
          // 菜被删了也保留当时记下的名字（跟订单汇总同一个口径，不丢历史）
          name: dish.name || it.name || '已删除的菜',
          emoji: dish.emoji || it.emoji || '🍽',
          count: 0
        };
      }
      index[it.dishId].count += 1;
    });
  });

  return Object.keys(index)
    .map((k) => index[k])
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** [{ dishId, count }] → { dishId: count }，给菜品行直接取用 */
function likeMapOf(totals) {
  const m = {};
  (totals || []).forEach((t) => {
    m[t.dishId] = t.count;
  });
  return m;
}

/**
 * 点赞的候选名单：今晚真正吃到的菜。
 *
 * 取 = 订单里出现过的菜（已按份数排序） ∪ 已上架的菜。
 * 为什么连"已下架但点过"的也算：家宴一结束，主人常把菜一键全部下架，
 * 那时候朋友端菜单是空的——可恰恰是这时候大家才来点赞。
 */
function buildBallot(orderDocs, dishDocs, likeMap) {
  const dishMap = {};
  (dishDocs || []).forEach((d) => {
    dishMap[d._id] = d;
  });

  const qtyOf = {};
  (orderDocs || []).forEach((o) => {
    (o.items || []).forEach((i) => {
      qtyOf[i.dishId] = (qtyOf[i.dishId] || 0) + (Number(i.qty) || 0);
    });
  });

  const seen = {};
  const list = [];
  const push = (dishId, fallbackName) => {
    if (!dishId || seen[dishId]) return;
    seen[dishId] = true;
    const dish = dishMap[dishId] || {};
    list.push({
      dishId: dishId,
      name: dish.name || fallbackName || '已删除的菜',
      emoji: dish.emoji || '🍽',
      qty: qtyOf[dishId] || 0,
      ordered: !!qtyOf[dishId],
      likeCount: (likeMap && likeMap[dishId]) || 0
    });
  };

  // 点过的先列（按份数从多到少），没点过的上架菜跟在后面
  (orderDocs || []).forEach((o) => {
    (o.items || []).forEach((i) => push(i.dishId, i.name));
  });
  list.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  (dishDocs || []).forEach((d) => {
    if (d.available) push(d._id, d.name);
  });

  return list;
}

/**
 * 看看点赞情况（不需要口令，任何朋友都能看）
 *
 * 一次返回三样，朋友端不用再发第二个请求：
 *   candidates 今晚的菜（投票候选）+ myVotes 我投了哪些 + 合计人数
 * 刻意只返回菜名和人数，不带别人的 openid。
 */
async function handleVotes(openid) {
  const [votes, dishRes, orderRes] = await Promise.all([
    readVotes(),
    db.collection('dishes').limit(MAX_LIMIT).get(),
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get()
  ]);
  const mine = votes.filter((v) => v._openid === openid)[0];
  const totals = buildLikeTotals(votes, dishRes.data);

  return ok({
    myVotes: mine ? (mine.items || []).map((i) => i.dishId) : [],
    myVoteNames: mine ? (mine.items || []).map((i) => i.name) : [],
    candidates: buildBallot(orderRes.data, dishRes.data, likeMapOf(totals)),
    totals: totals,
    likeMap: likeMapOf(totals),
    voterCount: votes.length,
    maxVotes: MAX_VOTES
  });
}

/**
 * 提交点赞：从菜单里挑最多 3 道菜。
 *
 * 几点刻意的设计：
 *   - **不受点单截止时间限制**：点赞本来就是吃完才做的事，截止后才是投票高峰。
 *   - **重复提交即覆盖**：跟点单一样，改主意了直接重交，不需要先撤销。
 *   - **传空数组 = 撤销我的赞**：不报错（幂等），方便"点错了想全撤"。
 *   - **只认菜库里真实存在的菜**：已下架的菜照样能点赞（家宴结束后主人常把菜下架），
 *     但菜库里删掉的菜就投不了，避免刷出一堆幽灵条目。
 */
async function handleSubmitVotes(openid, event) {
  const cfg = await getConfig();
  if (!cfg) throw new Error('家宴还没初始化，请等主人开通');

  const raw = Array.isArray(event.dishIds) ? event.dishIds : [];

  const dishRes = await db.collection('dishes').limit(MAX_LIMIT).get();
  const byId = {};
  (dishRes.data || []).forEach((d) => {
    byId[d._id] = d;
  });

  const items = [];
  for (const r of raw) {
    const id = str(r, 64);
    if (!id || !byId[id]) continue; // 不存在 / 空值：跳过
    if (items.some((it) => it.dishId === id)) continue; // 同一道菜只算一票
    items.push({ dishId: id, name: byId[id].name, emoji: byId[id].emoji || '🍽' });
  }

  // 注意：先去掉重复和无效应答再判上限。
  // 否则客户端传了 [A, B, C, A] 这种带重复的数组，会被误判成"投了 4 道"而拒绝。
  if (items.length > MAX_VOTES) throw new Error('最多只能给 ' + MAX_VOTES + ' 道菜点赞');

  const mine = await withCollection('votes', () => db.collection('votes').where({ _openid: openid }).limit(1).get());
  const existed = !!(mine.data && mine.data.length);

  if (!items.length) {
    if (existed) {
      await withCollection('votes', () => db.collection('votes').doc(mine.data[0]._id).remove());
    }
    return ok({ cleared: true, count: 0, dishIds: [] });
  }

  const doc = { _openid: openid, items: items, updatedAt: db.serverDate() };
  if (existed) {
    await withCollection('votes', () => db.collection('votes').doc(mine.data[0]._id).update({ data: doc }));
  } else {
    doc.createdAt = db.serverDate();
    await withCollection('votes', () => db.collection('votes').add({ data: doc }));
  }

  return ok({
    cleared: false,
    count: items.length,
    dishIds: items.map((i) => i.dishId),
    names: items.map((i) => i.name),
    maxVotes: MAX_VOTES
  });
}

/** 清空所有点赞（主人用：换季/试完想重来） */
async function handleResetVotes(openid) {
  await requireAdmin(openid);
  const votes = await readVotes();
  if (!votes.length) return ok({ cleared: 0 });

  // 逐条删：比 where().remove() 稳妥，也不受单次删除上限影响
  for (let i = 0; i < votes.length; i += 20) {
    await Promise.all(
      votes.slice(i, i + 20).map((v) => withCollection('votes', () => db.collection('votes').doc(v._id).remove()))
    );
  }
  return ok({ cleared: votes.length });
}

/** 后厨看板汇总（仅主人） */
async function handleSummary(openid) {
  await requireAdmin(openid);
  const cfg = await getConfig();
  const [orderRes, dishRes, votes] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get(),
    db.collection('dishes').limit(MAX_LIMIT).get(),
    readVotes()
  ]);

  const likes = buildLikeTotals(votes, dishRes.data);
  const data = aggregateOrders(cfg, orderRes.data, dishRes.data, true, likeMapOf(likes));
  const ingredients = buildIngredients(dishRes.data, orderRes.data, cfg.shopping || {}, cfg.pantry || {});
  const pantry = pantryList(cfg);

  // 三个数加起来正好是 total：家里有的 / 已经买了的 / 还要买的
  const inStock = ingredients.filter((i) => i.inStock).length;
  const purchased = ingredients.filter((i) => i.purchased && !i.inStock).length;
  const missing = ingredients.length - inStock - purchased;

  return ok(
    Object.assign({ config: publicConfig(cfg, true) }, data, {
      ingredients: ingredients,
      pantry: pantry,
      likes: likes,
      likeStats: { voters: votes.length, likedDishes: likes.length, maxVotes: MAX_VOTES },
      ingredientStats: {
        total: ingredients.length,
        missing: missing,
        purchased: purchased,
        inStock: inStock,
        pantryCount: pantry.length
      }
    })
  );
}

/** 主人端勾选 / 取消「已采购」 */
async function handleToggleIngredient(openid, event) {
  const cfg = await requireAdmin(openid);
  const name = str(event.name, 20);
  if (!name) throw new Error('缺少食材名');

  const shopping = Object.assign({}, cfg.shopping || {});
  if (event.purchased) shopping[name] = true;
  else delete shopping[name];

  await saveConfig(Object.assign({}, cfg, { shopping: shopping }));
  return ok({ name: name, purchased: !!event.purchased, purchasedCount: Object.keys(shopping).length });
}

/** 清空所有采购勾选（下次家宴复用同一份清单时用） */
async function handleResetShopping(openid) {
  const cfg = await requireAdmin(openid);
  const cleared = Object.keys(cfg.shopping || {}).length;
  await saveConfig(Object.assign({}, cfg, { shopping: {} }));
  return ok({ cleared: cleared });
}

/**
 * 朋友端的「大家都在点什么」（不需要口令，任何朋友都能看）
 *
 * 刻意只返回必要字段：没有主人口令、没有 openid、没有订单 id。
 * 家宴场景下"谁点了什么"本来就是公开的，这也是朋友之间互相可见的意义。
 */
async function handleBoard() {
  const cfg = await getConfig();
  if (!cfg) return ok({ inited: false, orders: [], dishTotals: [], likes: [], stats: { orderCount: 0, totalPeople: 0, totalDishes: 0, dishKindCount: 0 } });

  const [orderRes, dishRes, votes] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get(),
    db.collection('dishes').limit(MAX_LIMIT).get(),
    readVotes()
  ]);

  const likes = buildLikeTotals(votes, dishRes.data);
  const data = aggregateOrders(cfg, orderRes.data, dishRes.data, false, likeMapOf(likes));
  return ok(Object.assign({ inited: true, config: publicConfig(cfg, false), likes: likes, voterCount: votes.length }, data));
}

/**
 * 主人端调整点单 —— 「这道菜不做了」或「去掉某个人点的某道菜」
 *
 *   { dishId }            → 从**所有**订单里去掉这道菜，并顺手把它下架（免得又被点回来）
 *   { dishId, orderId }   → 只去掉这一单里的这道菜
 *
 * 细节：
 *   - 去掉后如果是空单，整单删掉。留着 0 道的空订单会把汇总里的"到场人数"算多。
 *   - 被改动的订单留一条 hostNote，朋友打开「我的点单」能看到自己被动过什么。
 *   - 这个接口**不检查截止时间**：主人备菜过程中随时可能需要砍菜，这是有意的。
 */
async function handleDropDish(openid, event) {
  await requireAdmin(openid);
  const dishId = str(event.dishId, 64);
  if (!dishId) throw new Error('缺少菜品信息');
  const orderId = str(event.orderId, 64);

  let orders = [];
  if (orderId) {
    try {
      const res = await db.collection('orders').doc(orderId).get();
      if (res.data) orders = [res.data];
    } catch (e) {
      throw new Error('这一单已经不在了，下拉刷新看看');
    }
  } else {
    const res = await db.collection('orders').limit(MAX_LIMIT).get();
    orders = res.data || [];
  }

  let touched = 0;
  let emptied = 0;
  const droppedNames = [];

  for (const o of orders) {
    const items = o.items || [];
    const kept = items.filter((i) => i.dishId !== dishId);
    if (kept.length === items.length) continue; // 这一单没点它，跳过

    items
      .filter((i) => i.dishId === dishId)
      .forEach((i) => {
        if (i.name && droppedNames.indexOf(i.name) < 0) droppedNames.push(i.name);
      });

    if (!kept.length) {
      await db.collection('orders').doc(o._id).remove();
      emptied += 1;
    } else {
      const totalQty = kept.reduce((s, i) => s + (Number(i.qty) || 0), 0);
      await db.collection('orders').doc(o._id).update({
        data: {
          items: kept,
          totalQty,
          hostNote: '主人去掉了：' + droppedNames.join('、'),
          updatedAt: db.serverDate()
        }
      });
    }
    touched += 1;
  }

  // 从所有订单去掉时，顺手把这道菜下架，避免朋友又点回来
  let unlisted = false;
  if (!orderId) {
    try {
      const dishRes = await db.collection('dishes').doc(dishId).get();
      if (dishRes.data && dishRes.data.available) {
        await db.collection('dishes').doc(dishId).update({ data: { available: false } });
        unlisted = true;
      }
    } catch (e) {
      /* 菜品可能已经被删了，不影响这次调整 */
    }
  }

  return ok({ touched, emptied, unlisted, names: droppedNames });
}

/**
 * 主人端改某一单里某道菜的份数 —— 朋友误点多了，主人直接减。
 *
 *   { orderId, dishId, qty }   qty = 0 表示整条去掉
 *
 * 和 dropDish 一样不检查截止时间（备菜过程中随时可能要调），
 * 并且会把改动写进 hostNote，朋友打开「我的点单」能看到。
 */
async function handleSetItemQty(openid, event) {
  await requireAdmin(openid);
  const orderId = str(event.orderId, 64);
  const dishId = str(event.dishId, 64);
  if (!orderId || !dishId) throw new Error('缺少参数');
  // 必须显式传份数：不能靠默认值，否则漏传参数会被当成"减成 0 份"而误删
  if (event.qty === undefined || event.qty === null || event.qty === '') throw new Error('缺少份数');
  const qty = int(event.qty, 0, 0, 99);

  let order = null;
  try {
    const res = await db.collection('orders').doc(orderId).get();
    order = res.data || null;
  } catch (e) {
    throw new Error('这一单已经不在了，下拉刷新看看');
  }
  if (!order) throw new Error('这一单已经不在了，下拉刷新看看');

  const items = order.items || [];
  const target = items.filter((i) => i.dishId === dishId)[0];
  if (!target) throw new Error('这一单里已经没有这道菜了，刷新看看');

  const name = target.name || '这道菜';
  let nextItems;
  let hostNote;

  if (qty <= 0) {
    nextItems = items.filter((i) => i.dishId !== dishId);
    hostNote = '主人去掉了：' + name;
  } else {
    nextItems = items.map((i) => (i.dishId === dishId ? Object.assign({}, i, { qty }) : i));
    hostNote = '主人把 ' + name + ' 改成了 ×' + qty;
  }

  // 改完一个菜都不剩，就整单删掉（留着 0 道的空单会把"到场人数"算多）
  if (!nextItems.length) {
    await db.collection('orders').doc(orderId).remove();
    return ok({ qty: qty <= 0 ? 0 : qty, removedOrder: true, name });
  }

  const totalQty = nextItems.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  await db.collection('orders').doc(orderId).update({
    data: { items: nextItems, totalQty, hostNote, updatedAt: db.serverDate() }
  });
  return ok({ qty, removedOrder: false, totalQty, name });
}

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event && event.action;

  try {
    if (!openid) return fail('无法获取用户身份，请在微信内打开');
    switch (action) {
      case 'init':
        return await handleInit(openid, event);
      case 'whoami':
        return await handleWhoami(openid);
      case 'listDishes':
        return await handleListDishes(openid, event);
      case 'seedDishes':
        return await handleSeedDishes(openid, event);
      case 'toggleDish':
        return await handleToggleDish(openid, event);
      case 'batchToggle':
        return await handleBatchToggle(openid, event);
      case 'updateDish':
        return await handleUpdateDish(openid, event);
      case 'addDish':
        return await handleAddDish(openid, event);
      case 'removeDish':
        return await handleRemoveDish(openid, event);
      case 'updateConfig':
        return await handleUpdateConfig(openid, event);
      case 'submitOrder':
        return await handleSubmitOrder(openid, event);
      case 'myOrder':
        return await handleMyOrder(openid);
      case 'cancelOrder':
        return await handleCancelOrder(openid);
      case 'summary':
        return await handleSummary(openid);
      case 'board':
        return await handleBoard();
      case 'dropDish':
        return await handleDropDish(openid, event);
      case 'setItemQty':
        return await handleSetItemQty(openid, event);
      case 'toggleIngredient':
        return await handleToggleIngredient(openid, event);
      case 'resetShopping':
        return await handleResetShopping(openid);
      case 'listPantry':
        return await handleListPantry(openid);
      case 'savePantryItems':
        return await handleSavePantryItems(openid, event);
      case 'removePantryItem':
        return await handleRemovePantryItem(openid, event);
      case 'clearPantry':
        return await handleClearPantry(openid);
      case 'votes':
        return await handleVotes(openid);
      case 'submitVotes':
        return await handleSubmitVotes(openid, event);
      case 'resetVotes':
        return await handleResetVotes(openid);
      default:
        return fail('未知操作：' + action);
    }
  } catch (err) {
    return fail((err && err.message) || String(err));
  }
};
