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
    hasHostOrder: false
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
        limitText: t.limit ? '限 ' + t.limit + ' 份' : '',
        guestsText: (t.guests || []).join('、'),
        notes: t.notes || []
      }));

      const orders = this.mapOrders(res.orders);

      const now = new Date();
      this.setData({
        loading: false,
        isAdmin: true,
        stats: res.stats || this.data.stats,
        dishTotals,
        orders,
        hasHostOrder: orders.some((o) => o.isHost),
        deadlineText: deadlineTs ? fmt.fmtShort(deadlineTs) + '（' + fmt.countdown(deadlineTs) + '）' : '不限时间',
        closed: !!(deadlineTs && Date.now() > deadlineTs),
        updatedAt: fmt.pad(now.getHours()) + ':' + fmt.pad(now.getMinutes()) + ':' + fmt.pad(now.getSeconds()),
        text: this.buildText(cfg, res, dishTotals, orders)
      });
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

  buildText(cfg, res, dishTotals, orders) {
    const stats = res.stats || {};
    const lines = [];
    lines.push('🍽 ' + (cfg.title || '家宴') + ' 点单汇总');
    lines.push('已下单 ' + stats.orderCount + ' 人 · 到场约 ' + stats.totalPeople + ' 人 · 共 ' + stats.totalDishes + ' 道菜');
    lines.push('');
    lines.push('【菜品清单】');
    if (!dishTotals.length) {
      lines.push('（还没有人点单）');
    } else {
      dishTotals.forEach((t) => {
        let s = t.emoji + ' ' + t.name + ' ×' + t.qty;
        if (t.guestsText) s += ' —— ' + t.guestsText;
        lines.push(s);
        (t.notes || []).forEach((n) => lines.push('    ↳ ' + n));
      });
    }
    lines.push('');
    lines.push('【按人明细】');
    if (!orders.length) {
      lines.push('（还没有人点单）');
    } else {
      orders.forEach((o) => {
        let head = '· ' + o.nick + '（' + o.partySize + ' 人';
        if (o.arriveAt) head += '，' + o.arriveAt + ' 到';
        head += '）';
        if (o.isHost) head += ' ← 主人自己的单';
        lines.push(head);
        o.items.forEach((i) => {
          lines.push('    ' + i.name + ' ×' + i.qty + (i.note ? '（' + i.note + '）' : ''));
        });
        if (o.note) lines.push('    备注：' + o.note);
      });
    }
    return lines.join('\n');
  },

  onCopy() {
    if (!this.data.text) return api.toast('还没有内容可复制');
    wx.setClipboardData({
      data: this.data.text,
      success() {
        api.toast('已复制，粘给家人就行', 'success');
      }
    });
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
