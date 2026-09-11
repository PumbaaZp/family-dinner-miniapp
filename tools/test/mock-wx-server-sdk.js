/**
 * wx-server-sdk 的本地模拟实现（仅用于离线测试云函数逻辑）
 *
 * 只实现本项目用到的能力：
 *   db.createCollection / db.collection().doc().get|update|remove|set
 *   db.collection().add / where / limit / orderBy / get / count / update / remove
 *   db.command.in|neq|eq|exists
 *   db.serverDate()
 *   cloud.getWXContext()
 *
 * 行为尽量贴近真实云开发：
 *   - 集合不存在时查询/写入报错
 *   - doc().get()/update() 对不存在的文档报错
 *   - 服务端 where().update() 支持批量更新并返回 stats.updated
 */

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  Object.keys(v).forEach((k) => {
    out[k] = clone(v[k]);
  });
  return out;
}

function isCmd(v) {
  return !!v && typeof v === 'object' && typeof v.__cmd === 'string';
}

function resolveWriteValue(v) {
  if (v && typeof v === 'object') {
    if (v.__serverDate) return new Date();
    if (Array.isArray(v)) return v.map(resolveWriteValue);
    if (!isCmd(v)) {
      const out = {};
      Object.keys(v).forEach((k) => {
        out[k] = resolveWriteValue(v[k]);
      });
      return out;
    }
  }
  return v;
}

function matchValue(docVal, cond) {
  if (isCmd(cond)) {
    switch (cond.__cmd) {
      case 'in':
        return cond.value.indexOf(docVal) >= 0;
      case 'nin':
        return cond.value.indexOf(docVal) < 0;
      case 'neq':
        return docVal !== cond.value;
      case 'eq':
        return docVal === cond.value;
      case 'exists':
        return cond.value ? docVal !== undefined : docVal === undefined;
      case 'and':
        return cond.value.every((c) => matchValue(docVal, c));
      case 'or':
        return cond.value.some((c) => matchValue(docVal, c));
      default:
        throw new Error('mock 未实现的查询指令：' + cond.__cmd);
    }
  }
  if (Array.isArray(docVal) || Array.isArray(cond)) {
    return JSON.stringify(docVal) === JSON.stringify(cond);
  }
  return docVal === cond;
}

function createMockCloud(state) {
  const db = {};

  const command = {
    in: (arr) => ({ __cmd: 'in', value: arr }),
    nin: (arr) => ({ __cmd: 'nin', value: arr }),
    neq: (v) => ({ __cmd: 'neq', value: v }),
    eq: (v) => ({ __cmd: 'eq', value: v }),
    exists: (b) => ({ __cmd: 'exists', value: b }),
    and: (...cs) => ({ __cmd: 'and', value: cs }),
    or: (...cs) => ({ __cmd: 'or', value: cs })
  };

  function needCollection(name) {
    if (!state.collections[name]) {
      const e = new Error('collection not exists: ' + name);
      e.errCode = -502005;
      throw e;
    }
    return state.collections[name];
  }

  function findDoc(name, id) {
    return needCollection(name).find((d) => d._id === id);
  }

  function select(name, opts) {
    let docs = needCollection(name).slice();
    if (opts.where) {
      const keys = Object.keys(opts.where);
      docs = docs.filter((d) => keys.every((k) => matchValue(d[k], opts.where[k])));
    }
    if (opts.orderBy) {
      const { field, dir } = opts.orderBy;
      const sign = dir === 'desc' ? -1 : 1;
      docs.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        if (av instanceof Date || bv instanceof Date) {
          return (new Date(av).getTime() - new Date(bv).getTime()) * sign;
        }
        return (av > bv ? 1 : -1) * sign;
      });
    }
    if (opts.limit) docs = docs.slice(0, opts.limit);
    return docs;
  }

  function applyUpdate(doc, data) {
    Object.keys(data).forEach((k) => {
      doc[k] = resolveWriteValue(data[k]);
    });
  }

  function Doc(name, id) {
    return {
      async get() {
        // 模拟"读配置一直失败"的极端情况，用来验证初始化不会崩
        if (state.configReadFails && name === 'config') {
          const e = new Error('document.get:fail mock 模拟读失败');
          e.errCode = -1;
          throw e;
        }
        const d = findDoc(name, id);
        if (!d) {
          const e = new Error('document.get:fail document does not exist');
          e.errCode = -1;
          throw e;
        }
        return { data: clone(d) };
      },
      async set({ data }) {
        const d = findDoc(name, id);
        if (d) {
          Object.keys(d).forEach((k) => delete d[k]);
          Object.assign(d, { _id: id }, resolveWriteValue(data));
        } else {
          state.collections[name].push(Object.assign({ _id: id }, resolveWriteValue(data)));
        }
        return { stats: { updated: 1 } };
      },
      async update({ data }) {
        const d = findDoc(name, id);
        if (!d) {
          // 真实云开发 SDK 在文档不存在时的行为并不统一：
          // 有的抛错，有的只返回 stats.updated = 0。两种都要能测。
          if (state.updateOnMissing === 'silent') {
            return { stats: { updated: 0 } };
          }
          const e = new Error('document.update:fail document does not exist');
          e.errCode = -1;
          throw e;
        }
        applyUpdate(d, data);
        return { stats: { updated: 1 } };
      },
      async remove() {
        const list = needCollection(name);
        const i = list.findIndex((d) => d._id === id);
        if (i >= 0) list.splice(i, 1);
        return { stats: { removed: i >= 0 ? 1 : 0 } };
      }
    };
  }

  function Collection(name, opts) {
    opts = opts || { where: null, limit: null, orderBy: null };
    const chain = (patch) => Collection(name, Object.assign({}, opts, patch));
    return {
      doc: (id) => Doc(name, id),
      add: async ({ data }) => {
        const list = needCollection(name);
        state.seq += 1;
        const doc = Object.assign({ _id: 'mockid_' + state.seq }, resolveWriteValue(data));
        list.push(doc);
        return { _id: doc._id };
      },
      where: (cond) => chain({ where: cond }),
      limit: (n) => chain({ limit: n }),
      orderBy: (field, dir) => chain({ orderBy: { field, dir } }),
      get: async () => ({ data: select(name, opts).map(clone) }),
      count: async () => ({ total: select(name, opts).length }),
      update: async ({ data }) => {
        const docs = select(name, opts);
        docs.forEach((d) => applyUpdate(d, data));
        return { stats: { updated: docs.length } };
      },
      remove: async () => {
        const docs = select(name, opts);
        const ids = docs.map((d) => d._id);
        state.collections[name] = state.collections[name].filter((d) => ids.indexOf(d._id) < 0);
        return { stats: { removed: ids.length } };
      }
    };
  }

  db.collection = (name) => Collection(name);
  db.command = command;
  db.serverDate = () => ({ __serverDate: true });
  db.createCollection = async (name) => {
    if (state.collections[name]) {
      const e = new Error('collection already exists');
      e.errCode = -501001;
      throw e;
    }
    state.collections[name] = [];
    return { errMsg: 'createCollection:ok' };
  };
  db.RegExp = (o) => new RegExp(o.regexp, o.options);

  return {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: state.openid, APPID: 'wxmock', UNIONID: '' }),
    callFunction: async () => {
      throw new Error('mock 不支持云函数间调用');
    }
  };
}

function createState(opts) {
  const o = opts || {};
  return {
    collections: {},
    openid: '',
    seq: 0,
    // 'throw'：文档不存在时 update 抛错；'silent'：只返回 stats.updated = 0
    updateOnMissing: o.updateOnMissing || 'throw',
    configReadFails: !!o.configReadFails
  };
}

module.exports = { createMockCloud, createState };
