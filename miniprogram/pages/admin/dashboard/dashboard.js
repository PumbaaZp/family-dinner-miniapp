const api = require('../../../utils/api.js');
const fmt = require('../../../utils/format.js');

const app = getApp();

// 自动刷新间隔：下单期间要"实时"（朋友点一下，主人这头几乎立刻能看到）；
// 截止时间过了谁也改不了单，降频到 15 秒，别白烧云函数调用次数。
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 15000;

Page({
  data: {
    loading: true,
    isAdmin: false,
    stats: { orderCount: 0, totalPeople: 0, totalDishes: 0, dishKindCount: 0 },
    dishTotals: [],
    orders: [],
    text: '',
    deadlineText: '',
    closed: false,
    updatedAt: '',
    hasHostOrder: false,

    // 家宴标题（导出清单时用作标题）
    title: '',
    // 食材清单（含"是否已采购 / 家里有没有"）+ 统计
    ingredients: [],
    ingredientStats: { total: 0, missing: 0, purchased: 0, inStock: 0, pantryCount: 0 },
    // 客人的点赞（吃完的反馈，下次菜单的参考）
    likes: [],
    likesAll: [],
    likeStats: { voters: 0, likedDishes: 0, votersAll: 0, likedDishesAll: 0 },
    // 当前场次（后厨看板只看这一场；历史场次留在点赞榜里做参考）
    session: null,
    sessionText: '',
    // 三种导出的文本，load 时生成好，点按钮直接复制
    menuText: '',
    dishIngText: '',
    shopText: ''
  },

  onShow() {
    this.load().then(() => this.startAutoRefresh());
  },

  onHide() {
    this.stopAutoRefresh();
  },

  onUnload() {
    this.stopAutoRefresh();
  },

  onPullDownRefresh() {
    this.load({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  /**
   * 自动刷新：用 setTimeout 自我调度（而不是 setInterval），
   * 这样每一轮都能按"当前是否已截止"重新决定下一次的间隔。
   * 离开页面（onHide/onUnload）由 stopAutoRefresh 把待触发的定时器清掉。
   */
  startAutoRefresh() {
    this.stopAutoRefresh();
    this.scheduleRefresh();
  },

  scheduleRefresh() {
    const delay = this.data.closed ? POLL_IDLE_MS : POLL_ACTIVE_MS;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (this._loading) {
        this.scheduleRefresh(); // 上一轮还没回来，等下一轮再说
        return;
      }
      this.load({ silent: true }).then(() => this.scheduleRefresh());
    }, delay);
  },

  stopAutoRefresh() {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
  },

  async load(opts) {
    if (this._loading) return;
    this._loading = true;
    const silent = !!(opts && opts.silent);
    if (!silent) this.setData({ loading: true });
    try {
      const session = await app.ensureSession(false);
      if (!session.isAdmin) {
        this.setData({ loading: false });
        api.toast('只有主人能看后厨看板');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }

      const res = await api.call('summary');
      const cfg = res.config || {};
      const deadlineTs = Number(cfg.deadlineTs) || 0;

      const dishTotals = (res.dishTotals || []).map((t) => ({
        dishId: t.dishId,
        name: t.name,
        emoji: t.emoji,
        category: t.category,
        qty: t.qty,
        limit: t.limit,
        ingredients: t.ingredients || [],
        likeCount: Number(t.likeCount) || 0,
        likeText: t.likeCount ? '👍 ' + t.likeCount : '',
        limitText: t.limit ? '限 ' + t.limit + ' 份' : '',
        guestsText: (t.guests || []).join('、'),
        notes: t.notes || []
      }));

      const orders = this.mapOrders(res.orders);
      const ingredients = this.mapIngredients(res.ingredients);

      const now = new Date();
      const patch = {
        loading: false,
        isAdmin: true,
        title: cfg.title || '家宴',
        stats: res.stats || this.data.stats,
        dishTotals,
        orders,
        hasHostOrder: orders.some((o) => o.isHost),
        likes: this.mapLikes(res.likes),
        likesAll: this.mapLikes(res.likesAll),
        likeStats: res.likeStats || { voters: 0, likedDishes: 0, votersAll: 0, likedDishesAll: 0 },
        session: res.session || null,
        sessionText: res.session ? res.session.name + '（第 ' + res.session.no + ' 场）' : '',
        ingredientStats: res.ingredientStats || { total: 0, missing: 0, purchased: 0, inStock: 0, pantryCount: 0 },
        deadlineText: deadlineTs ? fmt.fmtShort(deadlineTs) + '（' + fmt.countdown(deadlineTs) + '）' : '不限时间',
        closed: !!(deadlineTs && Date.now() > deadlineTs),
        updatedAt: fmt.pad(now.getHours()) + ':' + fmt.pad(now.getMinutes()) + ':' + fmt.pad(now.getSeconds()),
        menuText: this.buildMenuText(cfg, dishTotals),
        dishIngText: this.buildDishIngredientText(cfg, dishTotals),
        shopText: this.buildShoppingText(cfg, ingredients)
      };

      // 食材可能有几十上百条，2 秒轮询时如果内容没变就别重绘（长列表重绘很贵）
      const sig = ingredients
        .map((i) => i.name + (i.purchased ? '1' : '0') + (i.inStock ? 'S' : ''))
        .join(',');
      if (sig !== this._ingSig) {
        patch.ingredients = ingredients;
        this._ingSig = sig;
      }
      if (!this.data.text) patch.text = patch.menuText;

      this.setData(patch);
    } catch (err) {
      // 自动刷新失败时不弹提示，避免每 15 秒骚扰一次；下拉刷新或重进页面会给出提示
      if (!silent) {
        this.setData({ loading: false });
        api.toastErr(err);
      }
    } finally {
      this._loading = false;
    }
  },

  /**
   * 把云函数返回的订单整理成渲染数据。
   * 每条订单和每个菜品条目都带一个稳定唯一的 key —— 不能用昵称当 key：
   * 家宴里两个人把昵称写成一样的完全可能，重复 key 会让列表渲染错乱。
   */
  mapOrders(rawOrders) {
    return (rawOrders || []).map((o, oi) => ({
      key: 'order_' + oi,
      // 订单 id：主人要能针对"某一单"做调整
      orderId: o.orderId,
      nick: o.nick,
      partySize: o.partySize,
      arriveAt: o.arriveAt,
      note: o.note,
      totalQty: o.totalQty,
      // 旧版云函数不会返回 isHost，这里容忍 undefined（不显示标记，也不会报错）
      isHost: !!o.isHost,
      items: (o.items || []).map((i, ii) => ({
        key: 'item_' + oi + '_' + ii,
        dishId: i.dishId,
        name: i.name,
        emoji: i.emoji || '🍽',
        qty: i.qty,
        note: i.note || ''
      }))
    }));
  },

  /** 食材清单 → 渲染数据 */
  mapIngredients(rawList) {
    let stockHeaderDone = false;
    return (rawList || []).map((i) => {
      const inStock = !!i.inStock;
      // 云函数把"家里已有的"排在最后，这里在第一条前面插一条小标题，
      // 让主人一眼看出"下面这些不用买"
      const showStockHeader = inStock && !stockHeaderDone;
      if (showStockHeader) stockHeaderDone = true;
      return {
        key: 'ing:' + i.name,
        name: i.name,
        purchased: !!i.purchased,
        inStock: inStock,
        showStockHeader: showStockHeader,
        dishesText: (i.dishes || []).join('、')
      };
    });
  },

  /** 点赞榜 → 渲染数据（前几名给个名次，方便下次照着做；并列出"是谁赞的"） */
  mapLikes(rawList) {
    const total = (rawList || []).length;
    const top = Number(rawList && rawList[0] ? rawList[0].count : 0) || 1;
    return (rawList || []).map((l, idx) => {
      const who = l.who || [];
      const shown = who.slice(0, 6).map((w) => (w.count > 1 ? w.name + '×' + w.count : w.name));
      return {
        key: 'like:' + l.dishId,
        rank: idx + 1,
        dishId: l.dishId,
        name: l.name,
        emoji: l.emoji || '🍽',
        count: Number(l.count) || 0,
        // 「是谁赞的」：名单太长就折起来，别把卡片撑爆
        whoText: shown.join('、') + (who.length > 6 ? ' 等 ' + who.length + ' 人（人次）' : ''),
        medal: idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '',
        // 第一名的条给满宽，其余按比例——一眼看出差距，也不用 canvas
        barPercent: total ? Math.round(((Number(l.count) || 0) / top) * 100) : 0
      };
    });
  },

  /** 把菜品按分类分组（三种导出都用得上） */
  groupByCat(dishTotals) {
    const order = [];
    const byCat = {};
    (dishTotals || []).forEach((t) => {
      const cat = t.category || '其他';
      if (!byCat[cat]) {
        byCat[cat] = [];
        order.push(cat);
      }
      byCat[cat].push(t);
    });
    return { order: order, byCat: byCat };
  },

  /**
   * ① 菜单清单（发给客人）
   * 只有菜名，**不含谁点的、不含份数** —— 发到群里就是一份干净菜单
   */
  buildMenuText(cfg, dishTotals) {
    const lines = [];
    lines.push('🍽 ' + ((cfg && cfg.title) || '家宴') + ' · 菜单');
    if (cfg && cfg.address) lines.push('📍 ' + cfg.address);
    if (!dishTotals.length) {
      lines.push('');
      lines.push('（还没有确定菜品）');
      return lines.join('\n');
    }
    const g = this.groupByCat(dishTotals);
    g.order.forEach((cat) => {
      lines.push('');
      lines.push('【' + cat + '】');
      g.byCat[cat].forEach((t) => lines.push('· ' + t.name));
    });
    lines.push('');
    lines.push('共 ' + dishTotals.length + ' 道菜');
    return lines.join('\n');
  },

  /** ② 菜 + 食材：给家里人/自己备菜用 */
  buildDishIngredientText(cfg, dishTotals) {
    const lines = [];
    lines.push('🍽 ' + ((cfg && cfg.title) || '家宴') + ' · 菜品与食材');
    if (!dishTotals.length) {
      lines.push('');
      lines.push('（还没有确定菜品）');
      return lines.join('\n');
    }
    const g = this.groupByCat(dishTotals);
    g.order.forEach((cat) => {
      lines.push('');
      lines.push('【' + cat + '】');
      g.byCat[cat].forEach((t) => {
        lines.push('· ' + t.name + ' ×' + t.qty);
        const ing = t.ingredients || [];
        lines.push('   食材：' + (ing.length ? ing.join('、') : '（还没配食材）'));
      });
    });
    return lines.join('\n');
  },

  /**
   * ③ 待购食材（只列"还要买"的）
   * 家里已有的、以及已经买好的都不列出来 —— 买菜时看的全是缺的
   */
  buildShoppingText(cfg, ingredients) {
    const lines = [];
    lines.push('🛒 ' + ((cfg && cfg.title) || '家宴') + ' · 待购食材');
    const all = ingredients || [];
    const inStock = all.filter((i) => i.inStock);
    const missing = all.filter((i) => !i.purchased && !i.inStock);
    const bought = all.length - inStock.length - missing.length;

    if (!all.length) {
      lines.push('');
      lines.push('（还没有食材清单）');
      return lines.join('\n');
    }
    if (!missing.length) {
      lines.push('');
      lines.push('要用的 ' + all.length + ' 项全都齐了 ✅');
      if (inStock.length) lines.push('（其中 ' + inStock.length + ' 项家里本来就有）');
      return lines.join('\n');
    }

    let head = '还要买 ' + missing.length + ' 项';
    if (inStock.length || bought) {
      const extra = [];
      if (inStock.length) extra.push('家里已有 ' + inStock.length + ' 项');
      if (bought) extra.push('已买 ' + bought + ' 项');
      head += '（本次要用 ' + all.length + ' 项 · ' + extra.join(' · ') + '）';
    }
    lines.push(head);
    lines.push('');
    missing.forEach((i) => lines.push('· ' + i.name));
    if (inStock.length) {
      lines.push('');
      lines.push('（家里已有的 ' + inStock.length + ' 项没列出来）');
    }
    return lines.join('\n');
  },

  /** 按"家里有 / 已买 / 还要买"重新算一遍三个数（本地改完不用等云函数） */
  countStats(list) {
    const all = list || [];
    const inStock = all.filter((i) => i.inStock).length;
    const purchased = all.filter((i) => i.purchased && !i.inStock).length;
    return { total: all.length, inStock: inStock, purchased: purchased, missing: all.length - inStock - purchased };
  },

  /** 复制文本：把内容写进剪贴板，同时记下来供「预览」用 */
  copyText(text, okMsg) {
    if (!text) return api.toast('还没有内容可复制');
    wx.setClipboardData({
      data: text,
      success: () => {
        this.setData({ text: text });
        api.toast(okMsg, 'success');
      }
    });
  },

  onCopyMenu() {
    this.copyText(this.data.menuText, '菜单已复制，发群里就行');
  },

  onCopyDishIngredient() {
    this.copyText(this.data.dishIngText, '菜 + 食材已复制');
  },

  onCopyShopping() {
    this.copyText(this.data.shopText, '待购食材已复制');
  },

  /** 点一下食材：已采购 ⇄ 未采购 */
  async onToggleIngredient(e) {
    const name = e.currentTarget.dataset.name;
    const purchased = e.currentTarget.dataset.purchased === 'on';
    try {
      await api.call('toggleIngredient', { name: name, purchased: purchased });

      const list = this.data.ingredients.map((i) => (i.name === name ? Object.assign({}, i, { purchased: purchased }) : i));
      // 本地已是最新，记下签名，免得下一次 2 秒轮询把它当"变化"重绘一遍
      this._ingSig = list.map((i) => i.name + (i.purchased ? '1' : '0') + (i.inStock ? 'S' : '')).join(',');

      this.setData({
        ingredients: list,
        ingredientStats: Object.assign({}, this.data.ingredientStats, this.countStats(list)),
        shopText: this.buildShoppingText({ title: this.data.title }, list)
      });
    } catch (err) {
      api.toastErr(err);
    }
  },

  /** 去「家里的库存」补录一些食材，回来待购清单就短了 */
  goPantry() {
    wx.navigateTo({ url: '/pages/admin/pantry/pantry' });
  },

  async onResetShopping() {
    const ok = await api.confirm('清空所有"已采购"勾选？\n\n食材清单会保留，只是把勾去掉（下次家宴复用同一份清单时用）。');
    if (!ok) return;
    api.loading('处理中');
    try {
      await api.call('resetShopping');
      api.hideLoading();
      this._ingSig = '';
      await this.load({ silent: true });
      api.toast('已清空勾选');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /** 清空点赞：默认只清本场（历史场次的票留着当参考） */
  async onResetVotes() {
    const n = this.data.likeStats.voters || 0;
    const name = (this.data.session && this.data.session.name) || '本场';
    const ok = await api.confirm('清空「' + name + '」的点赞？\n\n' + n + ' 个人的本场投票会被删掉；历史场次的票和累计榜不受影响。');
    if (!ok) return;
    api.loading('处理中');
    try {
      const res = await api.call('resetVotes', { sessionId: this.data.session ? this.data.session.id : '' });
      api.hideLoading();
      await this.load({ silent: true });
      api.toast('已清空 ' + res.cleared + ' 人的本场点赞');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /** 给当前这一场改个名字（比如「0913场家宴」） */
  async onRenameSession() {
    const cur = this.data.session;
    const input = await api.prompt('这一场叫什么？', '改这一场的名字', (cur && cur.name) || '第 1 场家宴');
    if (input === null) return;
    const name = String(input).trim();
    if (!name) return api.toast('名字不能为空');
    api.loading('保存中');
    try {
      const res = await api.call('renameSession', { name: name });
      api.hideLoading();
      await this.load({ silent: true });
      api.toast('已改名：' + res.session.name, 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /**
   * 开始新的一场家宴
   *
   * 上一场的订单和点赞会**原样保留**（朋友还能回去给那一场点赞，累计榜也不会丢），
   * 只是把「已采购」勾选重置了——那是上一场买菜用的。家里的库存不动。
   */
  async onNewSession() {
    const name = await api.prompt('给这一场起个名字（比如「中秋家宴」）', '开始新的一场家宴', '第 ' + ((this.data.session ? this.data.session.no : 0) + 1) + ' 场家宴');
    if (name === null) return;
    api.loading('准备中');
    try {
      const res = await api.call('newSession', { name: name });
      api.hideLoading();
      await this.load({ silent: true });
      wx.showModal({
        title: '新的一场开始了',
        content:
          '现在是「' + res.session.name + '」（第 ' + res.session.no + ' 场）。\n\n' +
          '上一场（' + res.prev.name + '）的订单和点赞都留着，朋友还能回去给那一场点赞。\n' +
          '「已采购」勾选已重置，家里的库存没动。\n\n' +
          '接着去「家宴设置与菜库」挑今晚的菜吧。',
        showCancel: false,
        confirmText: '知道了'
      });
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  onRefresh() {
    this.load();
  },

  /**
   * 「不做这道菜」：从所有订单里去掉它（并顺手下架）
   */
  onDropDish(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    this.dropDish(
      { dishId: id },
      '「' + name + '」不做了？\n\n会从所有人的订单里去掉它，并把它下架（免得又被点回来）。',
      name
    );
  },

  /**
   * 「去掉这一单里的这道菜」：只影响某一个人的订单
   */
  onDropOrderItem(e) {
    const orderId = e.currentTarget.dataset.order;
    const dishId = e.currentTarget.dataset.dish;
    const name = e.currentTarget.dataset.name;
    const who = e.currentTarget.dataset.who;
    this.dropDish({ dishId, orderId }, '去掉 ' + who + ' 点的「' + name + '」？', name, who);
  },

  /**
   * 减一份。减到 0 份就是整条去掉（服务端 qty=0 的语义）
   */
  onDecItem(e) {
    const d = e.currentTarget.dataset;
    const cur = Number(d.qty) || 0;
    const next = Math.max(0, cur - 1);
    const question =
      next === 0
        ? d.who + ' 的「' + d.name + '」减到 0 份，等于整条去掉，确定吗？'
        : '把 ' + d.who + ' 的「' + d.name + '」从 ×' + cur + ' 减到 ×' + next + '？';
    this.setItemQty({ orderId: d.order, dishId: d.dish, qty: next }, question, d.name, d.who);
  },

  /**
   * 点份数直接改成精确值（从 8 份改到 2 份不用点 6 次）
   */
  async onEditItemQty(e) {
    const d = e.currentTarget.dataset;
    const cur = Number(d.qty) || 0;
    const input = await api.prompt('现在是 ×' + cur + '。输入新的份数（填 0 就是去掉这道菜）', '改份数 · ' + d.name, String(cur));
    if (input === null) return;

    const next = fmt.parseQtyInput(input);
    if (next === null) return api.toast('没看懂这个数字，再试一次');
    if (next === cur) return;
    if (next === 0) {
      this.setItemQty({ orderId: d.order, dishId: d.dish, qty: 0 }, '把 ' + d.who + ' 的「' + d.name + '」改成 0 份（整条去掉）？', d.name, d.who);
      return;
    }
    this.setItemQty({ orderId: d.order, dishId: d.dish, qty: next }, '把 ' + d.who + ' 的「' + d.name + '」改成 ×' + next + '？', d.name, d.who);
  },

  async setItemQty(payload, question, name, who) {
    const ok = await api.confirm(question);
    if (!ok) return;
    api.loading('处理中');
    try {
      const res = await api.call('setItemQty', payload);
      api.hideLoading();

      let msg = res.qty > 0 ? '已把「' + name + '」改成 ×' + res.qty : '已去掉「' + name + '」';
      if (res.removedOrder) msg += '，' + (who || '这一单') + ' 已没有菜、整单删除';
      api.toast(msg);

      await this.load({ silent: true });
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async dropDish(payload, question, name, who) {
    const ok = await api.confirm(question);
    if (!ok) return;
    api.loading('处理中');
    try {
      const res = await api.call('dropDish', payload);
      api.hideLoading();

      let msg = res.touched ? '已去掉「' + name + '」' : '没有订单包含这道菜';
      if (res.touched > 1) msg = '已去掉「' + name + '」（' + res.touched + ' 单受影响）';
      if (res.emptied) msg += '，' + (who || '其中 ' + res.emptied + ' 单') + '已没有菜、整单删除';
      if (res.unlisted) msg += '，这道菜已下架';
      api.toast(msg);

      await this.load({ silent: true });
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  previewText() {
    if (!this.data.text) return;
    wx.showModal({
      title: '汇总文本预览',
      content: this.data.text.length > 500 ? this.data.text.slice(0, 500) + '…' : this.data.text,
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
