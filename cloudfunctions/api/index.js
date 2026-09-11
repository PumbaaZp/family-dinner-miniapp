/**
 * 家宴点菜 · 唯一云函数（action 路由）
 *
 * 为什么要"一个云函数"：部署时只需要右键上传一个函数，
 * 不用逐个部署 6 个函数，减少出错点。
 *
 * 数据库集合：dishes（菜库）、orders（点单）、config（家宴配置）
 * 全部读写都走云函数，因此**不需要在云开发控制台配置任何集合权限**。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = ['dishes', 'orders', 'config'];
const PARTY_ID = 'party';
const MAX_LIMIT = 500;

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
    sort: Number(d.sort) || 0,
    available: !!d.available
  }));
  return ok({ dishes, isAdmin });
}

/** 批量导入菜库：默认只补新增（不覆盖主人已经改过的菜） */
async function handleSeedDishes(openid, event) {
  await requireAdmin(openid);
  const list = Array.isArray(event.dishes) ? event.dishes.slice(0, 200) : [];
  if (!list.length) throw new Error('没有可导入的菜品');
  const overwrite = !!event.overwrite;

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
      sort: int(raw.sort, 0, 0, 9999),
      available: !!raw.available
    };
    const hit = byName[name];
    if (!hit) toAdd.push(data);
    else if (overwrite) toUpdate.push({ id: hit._id, data });
  }

  // 并发写入：36 道菜不要串行 36 次，否则容易撞上云函数默认超时
  const chunk = async (arr, size, worker) => {
    for (let i = 0; i < arr.length; i += size) {
      await Promise.all(arr.slice(i, i + size).map(worker));
    }
  };

  await chunk(toAdd, 10, (data) => db.collection('dishes').add({ data }));
  await chunk(toUpdate, 10, (item) => db.collection('dishes').doc(item.id).update({ data: item.data }));

  return ok({ added: toAdd.length, updated: toUpdate.length, total: list.length });
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
function aggregateOrders(cfg, orderDocs, dishDocs, withOrderId) {
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

/** 后厨看板汇总（仅主人） */
async function handleSummary(openid) {
  await requireAdmin(openid);
  const cfg = await getConfig();
  const [orderRes, dishRes] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get(),
    db.collection('dishes').limit(MAX_LIMIT).get()
  ]);

  const data = aggregateOrders(cfg, orderRes.data, dishRes.data, true);
  return ok(Object.assign({ config: publicConfig(cfg, true) }, data));
}

/**
 * 朋友端的「大家都在点什么」（不需要口令，任何朋友都能看）
 *
 * 刻意只返回必要字段：没有主人口令、没有 openid、没有订单 id。
 * 家宴场景下"谁点了什么"本来就是公开的，这也是朋友之间互相可见的意义。
 */
async function handleBoard() {
  const cfg = await getConfig();
  if (!cfg) return ok({ inited: false, orders: [], dishTotals: [], stats: { orderCount: 0, totalPeople: 0, totalDishes: 0, dishKindCount: 0 } });

  const [orderRes, dishRes] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get(),
    db.collection('dishes').limit(MAX_LIMIT).get()
  ]);

  const data = aggregateOrders(cfg, orderRes.data, dishRes.data, false);
  return ok(Object.assign({ inited: true, config: publicConfig(cfg, false) }, data));
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
      default:
        return fail('未知操作：' + action);
    }
  } catch (err) {
    return fail((err && err.message) || String(err));
  }
};
