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

/**
 * 第 1 场家宴的 sessionId。
 *
 * 为什么要固定成 'party'：**老数据里没有 sessionId 这个字段**（这一版才加的场次概念），
 * 而那些订单/点赞都属于"第一场"。用 "缺字段 == 'party'" 来做等价，就不用跑数据迁移，
 * 老环境升级上来历史数据自动归位。
 */
const LEGACY_SESSION = 'party';

/** 每人最多给几道菜点赞 */
const MAX_VOTES = 3;

/** 没填昵称时的占位名。注意它不是"一个人的名字"，只用来显示 */
const ANON_NICK = '匿名朋友';

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
    // 场次：点单、点赞都按场次分开存，历史场次留着当参考
    sessionId: LEGACY_SESSION,
    sessionNo: 1,
    sessionName: '',
    sessionStartedAt: 0,
    sessions: [], // [{ id, no, name, ts }]，sessionListOf 会兜底补上当前这一场
    hostCode: hostCode || randomCode(),
    admins: []
  };
}

/* ------------------------------ 场次 ------------------------------ */

/** 一条订单/点赞属于哪一场（老数据没有 sessionId 字段 → 第 1 场） */
function sessionIdOf(doc) {
  const id = doc && doc.sessionId;
  return id ? String(id) : LEGACY_SESSION;
}

/** 当前场次 */
function sessionOf(cfg) {
  const c = cfg || {};
  return {
    id: c.sessionId ? String(c.sessionId) : LEGACY_SESSION,
    no: Number(c.sessionNo) || 1,
    name: c.sessionName || c.title || '第 1 场家宴',
    ts: Number(c.sessionStartedAt) || 0
  };
}

/**
 * 全部场次（新的在前）。
 *
 * 当前这一场的名字**以 `config.sessionName` 为准**，sessions 数组里那条只是历史存档：
 * 这样无论名字是被 renameSession 改的、还是直接在云开发控制台改库改的，
 * 看板、场次列表、朋友端的场次标签都会是一致的（不会出现"大厅改了、标签还是旧的"）。
 */
function sessionListOf(cfg) {
  const cur = sessionOf(cfg);
  const list = (cfg && Array.isArray(cfg.sessions) ? cfg.sessions : []).map((s) => ({
    id: String(s.id),
    no: Number(s.no) || 0,
    name: s.name || '第 ' + (Number(s.no) || 0) + ' 场家宴',
    ts: Number(s.ts) || 0
  }));

  const at = list.map((s) => s.id).indexOf(cur.id);
  if (at >= 0) list[at] = { id: cur.id, no: cur.no, name: cur.name, ts: cur.ts };
  else list.push({ id: cur.id, no: cur.no, name: cur.name, ts: cur.ts });

  return list.sort((a, b) => b.no - a.no || b.ts - a.ts);
}

/**
 * 某一场的对外描述：{ id, no, name, ts, current }。
 *
 * 字段名统一用 `id`（跟 sessions 数组里存的一致），不要再叫 sessionId ——
 * 以前这里是 sessionId、sessionOf 那边是 id，前端写成 `session.id` 就悄悄拿到 undefined，
 * 「清空本场点赞」会因此变成「清空全部点赞」。一个键名，一个来源。
 */
function sessionLabel(cfg, sessionId) {
  const cur = sessionOf(cfg);
  // 当前这一场直接用 config 里的最新值，不看 sessions 数组里的存档
  if (sessionId === cur.id) {
    return { id: cur.id, no: cur.no, name: cur.name, ts: cur.ts, current: true };
  }
  const hit = sessionListOf(cfg).filter((s) => s.id === sessionId)[0];
  const one = hit || { id: sessionId, no: 0, name: '家宴', ts: 0 };
  return {
    id: one.id,
    no: one.no,
    name: one.name,
    ts: one.ts,
    current: false
  };
}

/** 我在某一场的那一单（老数据缺 sessionId 也算第 1 场） */
async function findMyOrder(openid, sessionId) {
  const res = await db.collection('orders').where({ _openid: openid }).limit(MAX_LIMIT).get();
  return (res.data || []).filter((o) => sessionIdOf(o) === sessionId)[0] || null;
}

/** 只保留某一场的订单 / 点赞 */
function pickSession(docs, sessionId) {
  return (docs || []).filter((d) => sessionIdOf(d) === sessionId);
}

/**
 * 这一场"开席"了吗：有人点过单才算。
 *
 * 为什么需要这道门槛：主人一建好下一场，它就变成"当前这一场"，
 * 而当前场次的点赞候选＝现在上架的菜 —— 于是**下一场还没开始，朋友点开就能投票**。
 * 用"有人点过单"当开席信号最直白：这一场真的发生过。
 */
function sessionStarted(orderDocs, sessionId) {
  return (orderDocs || []).some((o) => sessionIdOf(o) === sessionId);
}

/** 对外暴露的配置：非管理员看不到主人口令 */
function publicConfig(cfg, isAdmin) {
  if (!cfg) return null;
  const s = sessionOf(cfg);
  const out = {
    title: cfg.title || '周末家宴',
    host: cfg.host || '主人',
    address: cfg.address || '',
    notice: cfg.notice || '',
    deadlineTs: Number(cfg.deadlineTs) || 0,
    maxDishesPerOrder: Number(cfg.maxDishesPerOrder) || 0,
    // 场次给所有人（朋友要靠它知道自己参加的是第几场）
    sessionId: s.id,
    sessionNo: s.no,
    sessionName: s.name
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
  const session = sessionOf(cfg);

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

  // 限量只看**你自己**点了几份，不看别人点了多少。
  //
  // 为什么改：一桌人各点各的，实际备餐都是"一份"，分量由主人自己拿主意。
  // 按"所有人加起来"卡的话，前面两个人各点 2 份就把后面的挡在门外了
  // （"只剩 0 份了"），而主人本来也没打算照份数做。所以 limit 的语义是
  // **每个客人对这道菜最多点几份**，多人点同一道菜不会再互相挤掉。
  for (const it of items) {
    const dish = dishMap[it.dishId];
    if (!dish) throw new Error('菜品不存在：' + (it.name || it.dishId));
    if (!dish.available) throw new Error(dish.name + ' 已经下架了');
    const limit = dish.limit === null || dish.limit === undefined ? 0 : Number(dish.limit);
    if (limit > 0 && it.qty > limit) {
      throw new Error(dish.name + ' 一个人最多点 ' + limit + ' 份');
    }
    it.name = dish.name;
    it.emoji = dish.emoji || '🍽';
  }

  const doc = {
    _openid: openid,
    // 订单按场次存：下一场家宴开起来时，这一单会**留在历史里**当参考，不会被覆盖掉
    sessionId: session.id,
    sessionNo: session.no,
    sessionName: session.name,
    nick: str(event.nick, 20) || ANON_NICK,
    partySize: int(event.partySize, 1, 1, 50),
    arriveAt: str(event.arriveAt, 20),
    note: str(event.note, 100),
    items,
    totalQty,
    // 朋友这次提交之后，之前"主人调整过你的点单"的提醒就算看过了
    hostNote: '',
    updatedAt: db.serverDate()
  };

  const mine = await findMyOrder(openid, session.id);
  if (mine) {
    await db.collection('orders').doc(mine._id).update({ data: doc });
    return ok({ orderId: mine._id, updated: true, session: session });
  }
  doc.createdAt = db.serverDate();
  const added = await db.collection('orders').add({ data: doc });
  return ok({ orderId: added._id, updated: false, session: session });
}

/** 我这一场的点单（不含别的场次的历史单） */
async function handleMyOrder(openid) {
  const cfg = await getConfig();
  const session = sessionOf(cfg);
  const order = await findMyOrder(openid, session.id);
  if (order) delete order._openid;
  return ok({ order, session: session });
}

async function handleCancelOrder(openid) {
  const cfg = await getConfig();
  const session = sessionOf(cfg);
  const mine = await findMyOrder(openid, session.id);
  if (mine) await db.collection('orders').doc(mine._id).remove();
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
      nick: o.nick || ANON_NICK,
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
 * 点赞汇总 → [{ dishId, name, emoji, count, who? }]，按人数降序。
 *
 * 一人一份票（重复提交即覆盖自己的），所以 count 就是「有多少人推荐这道菜」，
 * 同一个人反复来吃也不会把票数刷上去——这比累计历史点赞更适合当"下次点什么"的参考。
 *
 * withWho = true 时额外带上 `who: [{ name, count }]`（谁赞的）。
 * **只有主人端才允许带**：朋友端拿到的是同一份数据的"无姓名版"。
 */
function buildLikeTotals(voteDocs, dishDocs, nickIndex, withWho) {
  const dishMap = {};
  (dishDocs || []).forEach((d) => {
    dishMap[d._id] = d;
  });

  const index = {};
  (voteDocs || []).forEach((v) => {
    const voter = withWho ? voterNameOf(v, nickIndex) : '';
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
        if (withWho) index[it.dishId].who = [];
      }
      index[it.dishId].count += 1;
      if (withWho) index[it.dishId].who.push(voter);
    });
  });

  const list = Object.keys(index)
    .map((k) => index[k])
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // 一个人可能在好几场都赞了同一道菜：合并成「老王×2」，不然名单里会出现两个老王
  list.forEach((t) => {
    if (!withWho) return;
    const merged = [];
    (t.who || []).forEach((n) => {
      const hit = merged.filter((m) => m.name === n)[0];
      if (hit) hit.count += 1;
      else merged.push({ name: n, count: 1 });
    });
    merged.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    t.who = merged;
  });

  return list;
}

/**
 * { 'sessionId|openid': 昵称 }
 *
 * 老点赞记录里**没有存昵称**（这一版才加的），所以拿"他那一场的点单昵称"补上；
 * 连订单都没有的（只投票没点菜），就只能算匿名了。
 */
function buildNickIndex(orderDocs) {
  const m = {};
  (orderDocs || []).forEach((o) => {
    if (!o || !o._openid) return;
    m[sessionIdOf(o) + '|' + o._openid] = str(o.nick, 20) || ANON_NICK;
  });
  return m;
}

/** 一条点赞记录是谁赞的：优先用它自己存的昵称（快照），否则回退到那一场的订单昵称 */
function voterNameOf(voteDoc, nickIndex) {
  const key = sessionIdOf(voteDoc) + '|' + ((voteDoc && voteDoc._openid) || '');
  const fromOrder = (nickIndex || {})[key];
  const own = str(voteDoc && voteDoc.nick, 20);
  // 「匿名朋友」是没填名字时的**占位**，不算真名：
  // 不然同一个人"点赞时没填名字、点单时填了"就会被当成两个人，
  // 连着名字对不上的还有催票名单（明明投过了却被列进"还没投"）。
  if (own && own !== ANON_NICK) return own;
  return fromOrder || own || ANON_NICK;
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
 * 点赞的候选名单：这一场真正吃到的菜。
 *
 * 取 = 这一场订单里出现过的菜（按份数排序） ∪ 我自己在这一场投过的菜
 *      ∪（只有当前场次才加）已上架的菜。
 *
 * 为什么"已上架的菜"只给当前场次：上架状态是**现在**的菜单，跟三天前那场家宴没关系。
 * 为什么"我投过的菜"一定要在里面：不然那道菜后来被删了/换了，朋友就取消不掉了。
 * 为什么连"下架但点过"的也算：家宴一结束主人常把菜一键全部下架，
 * 那时候朋友端菜单是空的——可恰恰是这时候大家才来点赞。
 */
function buildBallot(orderDocs, dishDocs, likeMap, extraIds, includeAvailable) {
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

  // 点过的先列（按份数从多到少）
  (orderDocs || []).forEach((o) => {
    (o.items || []).forEach((i) => push(i.dishId, i.name));
  });
  list.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));

  // 我投过但这道菜没在这一场的订单里：补进来，让他能取消
  (extraIds || []).forEach((id) => push(id));
  if (includeAvailable) {
    (dishDocs || []).forEach((d) => {
      if (d.available) push(d._id, d.name);
    });
  }

  return list;
}

/**
 * 我在哪些场次露过面（点过单 或 投过票）。
 *
 * "去过一次"的定义就是这两件事之一，而不是"当时在不在饭桌上"——
 * 系统只能知道这些。当前这一场永远在列表里（哪怕还没点单，也可以先点赞）。
 */
async function handleMyDinners(openid) {
  const cfg = await getConfig();
  if (!cfg) return ok({ inited: false, current: null, dinners: [] });

  const cur = sessionOf(cfg);
  const [votes, orderRes] = await Promise.all([
    readVotes(),
    db.collection('orders').limit(MAX_LIMIT).get()
  ]);

  const index = {};
  const touch = (sid) => {
    if (!index[sid]) {
      index[sid] = Object.assign(sessionLabel(cfg, sid), { ordered: false, voted: false, voteCount: 0, orderQty: 0 });
    }
    return index[sid];
  };

  (orderRes.data || []).forEach((o) => {
    if (o._openid !== openid) return;
    const one = touch(sessionIdOf(o));
    one.ordered = true;
    one.orderQty = Number(o.totalQty) || 0;
    one.orderItems = (o.items || []).length;
  });
  votes.forEach((v) => {
    if (v._openid !== openid) return;
    const one = touch(sessionIdOf(v));
    one.voted = true;
    one.voteCount = (v.items || []).length;
    one.voteNames = (v.items || []).map((i) => i.name);
  });
  touch(cur.id);

  const dinners = Object.keys(index).map((k) => index[k]);
  // 当前这一场排最前，其余按场次序号倒序（最近的在上面）
  dinners.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.no || 0) - (a.no || 0) || (b.ts || 0) - (a.ts || 0);
  });

  return ok({ inited: true, current: cur, dinners: dinners, sessionCount: sessionListOf(cfg).length });
}

/**
 * 看看点赞情况（不需要口令，任何朋友都能看）
 *
 * event.sessionId 不传就当作"当前这一场"。一次返回朋友端要的全部东西：
 *   candidates 这一场的菜（投票候选）+ myVotes 我投了哪些 + 这一场合计 + 跨场次累计
 */
async function handleVotes(openid, event) {
  const cfg = await getConfig();
  const cur = sessionOf(cfg);
  const wantId = str(event && event.sessionId, 32) || cur.id;

  const [votes, dishRes, orderRes] = await Promise.all([
    readVotes(),
    db.collection('dishes').limit(MAX_LIMIT).get(),
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get()
  ]);

  const isCurrent = wantId === cur.id;
  const session = sessionLabel(cfg, wantId);
  const sessionVotes = pickSession(votes, wantId);
  const sessionOrders = pickSession(orderRes.data, wantId);
  const mine = sessionVotes.filter((v) => v._openid === openid)[0];
  const started = sessionStarted(orderRes.data, wantId);
  // 「我参加过这一场」= 这一场有我的点单，或者我这一场已经投过票（那样才改得动、撤得掉）
  const participated = !!mine || sessionOrders.some((o) => o._openid === openid);

  const totals = buildLikeTotals(sessionVotes, dishRes.data);
  const totalsAll = buildLikeTotals(votes, dishRes.data);
  const likeMap = likeMapOf(totals);
  const myVotes = mine ? (mine.items || []).map((i) => i.dishId) : [];

  return ok({
    session: session,
    current: cur,
    isCurrent: isCurrent,
    // 开席了吗：没开席就没什么可投的，客户端会显示"等大家点完菜再来投票"
    started: started,
    participated: participated,
    canVote: started && participated,
    myVotes: myVotes,
    myVoteNames: mine ? (mine.items || []).map((i) => i.name) : [],
    // 没开席时不列候选（除非我自己已经有票——那也得让我看得到、撤得掉）
    candidates: started || mine ? buildBallot(sessionOrders, dishRes.data, likeMap, myVotes, isCurrent) : [],
    totals: totals,
    totalsAll: totalsAll,
    likeMap: likeMap,
    likeMapAll: likeMapOf(totalsAll),
    voterCount: sessionVotes.length,
    voterCountAll: votes.length,
    maxVotes: MAX_VOTES
  });
}

/**
 * 给某一场的菜点赞：一人一场最多 3 道，重复提交即覆盖（传空数组 = 撤销）。
 *
 * 关键点：
 *   - **按场次存票**：同一个人来了三次、每次都给「红烧肉」点赞，那就是 3 票。
 *     跨场次累计时这正是想要的信号（"他来过三次都说好"）。
 *   - **一场一人一份票**：同一场里反复提交只会覆盖自己，不会把自己刷成 10 票。
 *   - **不受点单截止时间限制**：点赞本来就是吃完才做的事。
 *   - **只能给自己参加过的场次投票**（或当前这一场），防止翻旧账乱投。
 */
async function handleSubmitVotes(openid, event) {
  const cfg = await getConfig();
  if (!cfg) throw new Error('家宴还没初始化，请等主人开通');

  const cur = sessionOf(cfg);
  const sessionId = str(event.sessionId, 32) || cur.id;

  const [dishRes, orderRes, votes] = await Promise.all([
    db.collection('dishes').limit(MAX_LIMIT).get(),
    db.collection('orders').limit(MAX_LIMIT).get(),
    readVotes()
  ]);
  const mine = pickSession(votes, sessionId).filter((v) => v._openid === openid)[0];
  const ordered = pickSession(orderRes.data, sessionId).some((o) => o._openid === openid);
  // 只有**参加过这一场**的人能投票：这一场有你的点单，或者你这一场已经有票（那样才改得动、撤得掉）。
  // 不再允许"只要是当前场次谁都能投" —— 主人自己开的场、或者你根本没到场的那一场，都投不了。
  const participated = !!mine || ordered;
  if (!participated) throw new Error('这一场家宴你没参加过（这一场没有你的点单），投不了票');
  // 没开席（这一场还没有任何人点单）就不能投——不然主人一建好下一场，朋友就能提前把票投了。
  //
  // 唯一的例外：**你这一场已经有票了**。那种票是"没开席时投进去的"（早先版本留下的误投，
  // 或者你自己在别的设备上投的）。允许你改或者撤，不然你连撤都撤不掉，只能等主人去后台清。
  if (!sessionStarted(orderRes.data, sessionId) && !mine) {
    throw new Error('这一场还没开席（还没有人点单），等大家点完菜再来投吧');
  }

  const raw = Array.isArray(event.dishIds) ? event.dishIds : [];
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

  const label = sessionLabel(cfg, sessionId);
  const doc = {
    _openid: openid,
    sessionId: sessionId,
    sessionNo: label.no,
    sessionName: label.name,
    // 存下提交时的昵称快照：主人要靠它看出"这道菜是谁赞的"
    nick: str(event.nick, 20) || ANON_NICK,
    items: items,
    updatedAt: db.serverDate()
  };

  if (!items.length) {
    if (mine) await withCollection('votes', () => db.collection('votes').doc(mine._id).remove());
    return ok({ cleared: true, count: 0, dishIds: [], session: label });
  }

  if (mine) {
    await withCollection('votes', () => db.collection('votes').doc(mine._id).update({ data: doc }));
  } else {
    doc.createdAt = db.serverDate();
    await withCollection('votes', () => db.collection('votes').add({ data: doc }));
  }

  return ok({
    cleared: false,
    count: items.length,
    dishIds: items.map((i) => i.dishId),
    names: items.map((i) => i.name),
    session: label,
    maxVotes: MAX_VOTES
  });
}

/** 清空点赞：带 sessionId 只清那一场，不带就清全部 */
async function handleResetVotes(openid, event) {
  await requireAdmin(openid);
  const sessionId = str(event && event.sessionId, 32);
  const votes = await readVotes();
  const targets = sessionId ? votes.filter((v) => sessionIdOf(v) === sessionId) : votes;
  if (!targets.length) return ok({ cleared: 0, sessionId: sessionId || '' });

  // 逐条删：比 where().remove() 稳妥，也不受单次删除上限影响
  for (let i = 0; i < targets.length; i += 20) {
    await Promise.all(
      targets.slice(i, i + 20).map((v) => withCollection('votes', () => db.collection('votes').doc(v._id).remove()))
    );
  }
  return ok({ cleared: targets.length, sessionId: sessionId || '' });
}

/** 给当前这一场改个名字（只动名字，订单/点赞/库存毫发无损） */
async function handleRenameSession(openid, event) {
  const cfg = await requireAdmin(openid);
  const cur = sessionOf(cfg);
  const name = str(event.name, 20);
  if (!name) throw new Error('名字不能为空');

  // 同步改 sessions 列表里这一条（历史场次的名字不动）
  const sessions = sessionListOf(cfg).map((s) =>
    s.id === cur.id
      ? { id: s.id, no: s.no, name: name, ts: s.ts }
      : { id: s.id, no: s.no, name: s.name, ts: s.ts }
  );

  await saveConfig(Object.assign({}, cfg, { sessionName: name, sessions: sessions }));
  return ok({ prev: cur.name, session: { id: cur.id, no: cur.no, name: name, ts: cur.ts, current: true } });
}

/**
 * 开始新的一场家宴（仅主人）
 *
 * 做了三件事：
 *   1. 当前这一场归档进 sessions 列表，开一个新的 sessionId / 序号 / 名字
 *   2. 重置「已采购」勾选（那是上一场买菜用的），**家里的库存不动**
 *   3. 上一场的订单和点赞**原样保留**：朋友还能回去给那一场点赞，累计榜也不会丢
 *
 * 刻意不做的事：不动菜库的上架状态（主人自己决定今晚做什么）。
 */
async function handleNewSession(openid, event) {
  const cfg = await requireAdmin(openid);
  const cur = sessionOf(cfg);
  const no = cur.no + 1;
  const name = str(event.name, 20) || '第 ' + no + ' 场家宴';
  const id = 's' + Date.now().toString(36);
  const ts = Date.now();

  const sessions = sessionListOf(cfg).map((s) => ({ id: s.id, no: s.no, name: s.name, ts: s.ts }));
  sessions.push({ id: id, no: no, name: name, ts: ts });

  await saveConfig(
    Object.assign({}, cfg, {
      sessionId: id,
      sessionNo: no,
      sessionName: name,
      sessionStartedAt: ts,
      sessions: sessions,
      shopping: {} // 新的一场，采购勾选重来；pantry（家里有什么）保持
    })
  );

  return ok({
    prev: cur,
    session: { id: id, no: no, name: name, ts: ts, current: true },
    sessions: sessions.length
  });
}

/**
 * 按菜名猜分类（只用来**建议**，主人确认后才真的改）
 *
 * 为什么需要它：像「热菜」「快手菜」这种分类太宽泛（红烧肉、清蒸鲈鱼、可乐鸡翅都能算热菜；
 * 泡面加蛋、家常豆腐都能算快手菜），跟"是什么"（猪肉/蔬菜/主食）是两回事，
 * 主人想收拾掉它，就得把底下十几道菜一道道想"该归哪类"——很烦。
 * 这里按菜名的关键词给个建议，主人看一眼改几个就完事。
 *
 * 顺序有讲究：**先判"是什么"（鱼/虾蟹/猪/鸡），再判"怎么做"（汤羹/主食/甜品/饮品）**。
 * 反过来的话「可乐鸡翅」会被"可乐"判成饮品、「糖醋排骨」会被"糖"判成甜品。
 * 分类里没有「快手菜」——那不是一个"是什么"的分类，已并进具体分类（"快手"留在 tags 里）。
 */
const CATEGORY_HINTS = [
  ['鱼类', ['鱼']],
  ['贝蟹虾', ['虾', '蟹', '蛤', '蛏', '淡菜', '贝', '螺', '蚝', '牡蛎', '鱿', '墨鱼', '海参', '鲍']],
  ['汤羹', ['汤', '羹', '粥', '煲']],
  ['主食', ['饭', '面', '粉', '年糕', '饺', '馍', '饼', '馒头', '米线', '馄饨']],
  ['猪肉', ['猪', '排骨', '五花', '蹄', '肘', '里脊', '腊肉', '香肠', '火腿', '午餐肉', '肉末', '肉']],
  ['鸡肉', ['鸡', '鸭', '鹅', '翅', '腿']],
  // 「豆」不单独当关键词：不然「冰豆花」会被当成蔬菜
  ['蔬菜', ['菜', '瓜', '茄', '笋', '藕', '萝卜', '土豆', '菇', '菌', '豆腐', '椒', '番茄', '西红柿', '葱', '豆角', '四季豆', '豆芽', '蛋']],
  ['甜品', ['甜', '奶', '豆花', '糖', '布丁', '糕']],
  ['饮品', ['茶', '可乐', '雪碧', '汽水', '咖啡', '酒', '汁']]
];

function suggestCategory(name) {
  const n = String(name || '');
  for (const pair of CATEGORY_HINTS) {
    if (pair[1].some((k) => n.indexOf(k) >= 0)) return pair[0];
  }
  return '';
}

/**
 * 把某个分类整体挪走（用来干掉「热菜」这类太宽泛 / 重复的分类）
 *
 * event.from   要收拾的分类（必填）
 * event.to     目标分类；不传就按菜名自动归类（每道菜各自一个建议）
 * event.dryRun 只出方案不动数据（前端先给主人看一遍）
 *
 * 返回 plan = [{ id, name, to }]，主人确认后再跑一次（dryRun 关掉）即可。
 */
async function handleMergeCategory(openid, event) {
  await requireAdmin(openid);
  const from = str(event && event.from, 20);
  const to = str(event && event.to, 20);
  const dryRun = !!(event && event.dryRun);
  if (!from) throw new Error('缺少要整理的分类');
  if (to && to === from) throw new Error('目标和原来一样，不用整理');

  const res = await db.collection('dishes').limit(MAX_LIMIT).get();
  const targets = (res.data || []).filter((d) => (d.category || '自定义') === from);
  if (!targets.length) return ok({ from: from, to: to, moved: 0, dryRun: dryRun, plan: [], unmapped: [] });

  // 算出每道菜的目标分类：指定了 to 就全去 to，否则逐个按菜名建议；建议不出来的留在原分类
  const plan = [];
  const unmapped = [];
  targets.forEach((d) => {
    const dest = to || suggestCategory(d.name);
    if (!dest) {
      unmapped.push(d.name);
      return;
    }
    plan.push({ id: d._id, name: d.name, to: dest });
  });

  if (dryRun || !plan.length) {
    return ok({ from: from, to: to, moved: plan.length, dryRun: true, plan: plan, unmapped: unmapped });
  }

  for (let i = 0; i < plan.length; i += 10) {
    const chunk = plan.slice(i, i + 10);
    await Promise.all(chunk.map((p) => db.collection('dishes').doc(p.id).update({ data: { category: p.to } })));
  }

  const byTo = {};
  plan.forEach((p) => {
    byTo[p.to] = (byTo[p.to] || 0) + 1;
  });
  return ok({ from: from, to: to, moved: plan.length, dryRun: false, plan: plan, byTo: byTo, unmapped: unmapped });
}

/** 后厨看板汇总（仅主人） */
/**
 * 后厨看板汇总（仅主人）
 *
 * event.sessionId 不传 = 当前这一场；传了 = 回看那一场的历史（点单明细 + 点赞榜都按那一场）。
 * 唯一例外：**食材采购永远按当前这一场算** —— 买菜是给"现在"买的，回看历史场次时不该换。
 */
async function handleSummary(openid, event) {
  await requireAdmin(openid);
  const cfg = await getConfig();
  const cur = sessionOf(cfg);
  const viewId = str(event && event.sessionId, 32) || cur.id;
  const isCurrent = viewId === cur.id;

  const [orderRes, dishRes, votes] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get(),
    db.collection('dishes').limit(MAX_LIMIT).get(),
    readVotes()
  ]);

  const orders = pickSession(orderRes.data, viewId);
  const sessionVotes = pickSession(votes, viewId);

  // 主人端能看到"是谁赞的"，所以这两处 buildLikeTotals 都带 withWho
  const nickIndex = buildNickIndex(orderRes.data);
  const likes = buildLikeTotals(sessionVotes, dishRes.data, nickIndex, true);
  const likesAll = buildLikeTotals(votes, dishRes.data, nickIndex, true);
  const data = aggregateOrders(cfg, orders, dishRes.data, true, likeMapOf(likes));

  // 食材采购只跟当前这一场有关
  const currentOrders = pickSession(orderRes.data, cur.id);
  const ingredients = buildIngredients(dishRes.data, currentOrders, cfg.shopping || {}, cfg.pantry || {});
  const pantry = pantryList(cfg);

  // 三个数加起来正好是 total：家里有的 / 已经买了的 / 还要买的
  const inStock = ingredients.filter((i) => i.inStock).length;
  const purchased = ingredients.filter((i) => i.purchased && !i.inStock).length;
  const missing = ingredients.length - inStock - purchased;

  // 这一场点过单、但还没投票的人（主人要催票时看这个；主人自己不算）
  //
  // 判定用 openid 而不是昵称：昵称是客户端手填的，可能没填（占位「匿名朋友」）、
  // 可能两个人重名。按名字比对会把"投过的人"错认成"没投的人"，催票就催错了。
  // 名字只用来显示。
  const votedOpenids = {};
  sessionVotes.forEach((v) => {
    if (v && v._openid) votedOpenids[String(v._openid)] = true;
  });
  const notVoted = [];
  orders.forEach((o) => {
    if ((cfg.admins || []).indexOf(o._openid) >= 0) return;
    if (o._openid && votedOpenids[String(o._openid)]) return;
    const n = voterNameOf({ _openid: o._openid, nick: o.nick, sessionId: viewId }, nickIndex);
    if (notVoted.indexOf(n) < 0) notVoted.push(n);
  });

  return ok(
    Object.assign({ config: publicConfig(cfg, true) }, data, {
      session: sessionLabel(cfg, viewId),
      current: cur,
      isCurrent: isCurrent,
      sessions: sessionListOf(cfg),
      ingredients: ingredients,
      pantry: pantry,
      likes: likes,
      likesAll: likesAll,
      likeStats: {
        voters: sessionVotes.length,
        likedDishes: likes.length,
        maxVotes: MAX_VOTES,
        votersAll: votes.length,
        likedDishesAll: likesAll.length,
        notVoted: notVoted
      },
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
  if (!cfg) {
    return ok({
      inited: false,
      orders: [],
      dishTotals: [],
      likes: [],
      likesAll: [],
      session: null,
      stats: { orderCount: 0, totalPeople: 0, totalDishes: 0, dishKindCount: 0 }
    });
  }

  const session = sessionOf(cfg);
  const [orderRes, dishRes, votes] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'asc').limit(MAX_LIMIT).get(),
    db.collection('dishes').limit(MAX_LIMIT).get(),
    readVotes()
  ]);

  // 朋友端的「大家都在点什么」也只看当前这一场
  const orders = pickSession(orderRes.data, session.id);
  const sessionVotes = pickSession(votes, session.id);
  const likes = buildLikeTotals(sessionVotes, dishRes.data);
  const likesAll = buildLikeTotals(votes, dishRes.data);
  const data = aggregateOrders(cfg, orders, dishRes.data, false, likeMapOf(likes));

  return ok(
    Object.assign(
      {
        inited: true,
        config: publicConfig(cfg, false),
        session: session,
        likes: likes,
        likesAll: likesAll,
        voterCount: sessionVotes.length,
        voterCountAll: votes.length
      },
      data
    )
  );
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
        return await handleSummary(openid, event);
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
        return await handleVotes(openid, event);
      case 'submitVotes':
        return await handleSubmitVotes(openid, event);
      case 'resetVotes':
        return await handleResetVotes(openid, event);
      case 'myDinners':
        return await handleMyDinners(openid);
      case 'newSession':
        return await handleNewSession(openid, event);
      case 'renameSession':
        return await handleRenameSession(openid, event);
      case 'mergeCategory':
        return await handleMergeCategory(openid, event);
      default:
        return fail('未知操作：' + action);
    }
  } catch (err) {
    return fail((err && err.message) || String(err));
  }
};
