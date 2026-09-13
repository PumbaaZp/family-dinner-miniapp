const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');

const app = getApp();

Page({
  data: {
    loading: true,
    inited: false,
    isAdmin: false,
    cfg: null,
    deadlineText: '',
    closed: false,
    dishes: [],
    cats: [{ name: '全部', count: 0 }],
    activeCat: '全部',
    // 吸顶栏"当前高亮"的分类。和 activeCat（用于过滤列表）分开：
    // 滚动联动只改高亮，不能改过滤——否则滚到猪肉后随便点个 +，列表会突然只剩猪肉
    viewCat: '全部',
    // scroll-view 的 scroll-into-view 目标（让高亮的那一项自己滑进可视区）
    catScrollInto: '',
    shown: [],
    cartCount: 0,
    myOrder: null,

    showSubmit: false,
    nick: '',
    partySize: 2,
    arriveAt: '',
    note: '',
    submitting: false,

    // 「大家都在点什么」：朋友之间互相可见，不需要主人权限
    boardOpen: false,
    boardTotals: [],
    boardOrders: [],
    boardStats: { orderCount: 0, totalPeople: 0, totalDishes: 0 },

    // 点赞（吃完给家宴的菜投票，每人每场最多 maxVotes 道）
    likeOpen: false,
    dinners: [], // 我参加过的场次（用来切换着点评）
    currentSessionId: '',
    voteSessionId: '',
    voteSession: null,
    isCurrentVote: true,
    voteCandidates: [],
    voteList: [],
    myVotes: [],
    myVoteText: '',
    voterCount: 0,
    maxVotes: 3,
    pickCount: 0,
    likeMap: {}, // 本场：几人赞
    likeMapAll: {} // 跨场次累计：菜单行上的 👍N 用这个（"来过三次都说好"）
  },

  onLoad() {
    this.cart = {}; // dishId -> qty
    this.notes = {}; // dishId -> 备注
    this.bootstrap();
  },

  onShow() {
    if (!this._loaded) return;
    // 主人可能在别的页面改了菜/截止时间，返回时同步一次
    if (!this.data.inited) {
      this.bootstrap(true);
      return;
    }
    this.syncDeadline();
    this.reloadMenu();
    this.startDeadlineTick();
  },

  onHide() {
    this.stopDeadlineTick();
  },

  onUnload() {
    this.stopDeadlineTick();
  },

  /**
   * 每 30 秒本地重算一次倒计时 / 是否已截止。
   * 不请求网络，只重算显示：页面一直开着的话，到点会自动变成「已截止」，
   * 不会出现"把整张单子填完、点提交才被服务端拒绝"的体验。
   */
  startDeadlineTick() {
    this.stopDeadlineTick();
    this.deadlineTimer = setInterval(() => {
      this.syncDeadline();
      // 展开着的时候顺手刷新「大家都在点什么」，别人刚点的也能看到
      if (this.data.boardOpen) this.loadBoard(true);
    }, 30000);
  },

  stopDeadlineTick() {
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  },

  /** 轻量刷新菜单：不动购物车；被下架的菜要从购物车里剔除 */
  async reloadMenu() {
    try {
      const res = await api.call('listDishes');
      const dishes = res.dishes || [];
      const cats = this.buildCats(dishes);

      let pruned = 0;
      Object.keys(this.cart).forEach((id) => {
        if (!dishes.some((d) => d._id === id)) {
          delete this.cart[id];
          delete this.notes[id];
          pruned += 1;
        }
      });

      if (!cats.some((c) => c.name === this.data.activeCat)) this.setData({ activeCat: '全部' });
      this.setData({ dishes, cats, viewCat: '全部' }, () => this.buildShown());
      if (pruned) api.toast('有 ' + pruned + ' 道菜已被主人下架，已从你的点单里移除');
    } catch (err) {
      /* 静默失败即可，下拉刷新能重试 */
    }
  },

  onPullDownRefresh() {
    this.bootstrap(true).then(() => wx.stopPullDownRefresh());
  },

  /**
   * 根据滚动位置算出吸顶栏该高亮哪个分类（纯函数，方便测试）
   *
   * 规则：默认高亮「全部」；当某个分组标题越过了吸顶栏下沿，就把高亮切到那一类。
   */
  spyCat(sections, scrollTop, stickyH) {
    if (!sections || !sections.length) return '全部';
    const line = Number(scrollTop || 0) + Number(stickyH || 0) + 8;
    let name = '全部';
    for (let i = 0; i < sections.length; i += 1) {
      if (sections[i].top <= line) name = sections[i].name;
    }
    return name;
  },

  /**
   * 量出每个分组标题的绝对位置，供滚动联动使用。
   * 只在列表变化后量一次，滚动时只做数字比较，不反复查询节点。
   */
  measureSections() {
    if (!this._headerNames || !this._headerNames.length) {
      this._sections = [];
      return;
    }
    const q = wx.createSelectorQuery();
    q.selectAll('.cat-head').boundingClientRect();
    q.select('.cats-wrap').boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      const heads = (res && res[0]) || [];
      const bar = (res && res[1]) || null;
      const vp = (res && res[2]) || { scrollTop: 0 };
      if (!heads.length) {
        this._sections = [];
        return;
      }
      this._stickyH = bar ? bar.height : 0;
      this._sections = heads.map((h, i) => ({
        name: this._headerNames[i] || '',
        top: h.top + vp.scrollTop
      }));
    });
  },

  /** 滚到哪一类，吸顶栏就高亮哪一类 */
  onPageScroll(e) {
    if (this.data.activeCat !== '全部') return; // 只看"全部"模式（那种模式才分组标题）
    if (!this._sections || !this._sections.length) return;
    const name = this.spyCat(this._sections, e.scrollTop, this._stickyH);
    if (name === this.data.viewCat) return;
    const idx = this.data.cats.findIndex((c) => c.name === name);
    this.setData({ viewCat: name, catScrollInto: idx >= 0 ? 'cat-' + idx : '' });
  },

  onShareAppMessage() {
    const cfg = this.data.cfg || {};
    return {
      title: (cfg.title || '家宴') + '点菜啦，你想吃什么？',
      path: '/pages/index/index'
    };
  },

  onShareTimeline() {
    const cfg = this.data.cfg || {};
    return { title: (cfg.title || '家宴') + '点菜啦，你想吃什么？' };
  },

  /* -------------------- 大家都在点什么 -------------------- */

  onToggleBoard() {
    const boardOpen = !this.data.boardOpen;
    this.setData({ boardOpen });
    if (boardOpen) this.loadBoard(); // 展开时才拉，省一次请求
  },

  /**
   * 整理「大家都在点什么」的渲染数据。
   * 唯一 key 用下标派生——昵称可能重复（两个人写成一样的名字），
   * 直接拿昵称当 key 会让列表渲染复用错节点。
   */
  mapBoard(res) {
    const totals = (res.dishTotals || []).map((t) => ({
      dishId: t.dishId,
      emoji: t.emoji || '🍽',
      name: t.name,
      qty: t.qty,
      likeText: t.likeCount ? '👍 ' + t.likeCount : '',
      guestsText: (t.guests || []).join('、')
    }));
    const orders = (res.orders || []).map((o, idx) => ({
      key: 'b' + idx,
      nick: (o.nick || '匿名朋友') + (o.isHost ? '（主人）' : ''),
      partySize: o.partySize,
      itemsText: (o.items || []).map((it) => it.name + ' ×' + it.qty).join('、')
    }));
    return {
      totals,
      orders,
      stats: res.stats || { orderCount: 0, totalPeople: 0, totalDishes: 0 }
    };
  },

  async loadBoard(silent) {
    try {
      const res = await api.call('board');
      const mapped = this.mapBoard(res);
      this.setData({
        boardTotals: mapped.totals,
        boardOrders: mapped.orders,
        boardStats: mapped.stats
      });
    } catch (err) {
      if (!silent) api.toastErr(err);
    }
  },

  /* -------------------- 点赞（吃完给家宴的菜投票） -------------------- */

  onToggleLike() {
    const likeOpen = !this.data.likeOpen;
    this.setData({ likeOpen });
    if (likeOpen) {
      // 展开时同时刷新"我参加过的场次"和当前选中场次的票
      this.loadDinners();
      this.loadVotes(true, this.data.voteSessionId);
    }
  },

  /** 我参加过哪些场次（点过单或投过票的），当前这一场永远在里面 */
  async loadDinners() {
    try {
      const res = await api.call('myDinners');
      const cur = (res.current && res.current.id) || '';
      const patch = { dinners: res.dinners || [], currentSessionId: cur };
      if (!this.data.voteSessionId) patch.voteSessionId = cur;
      this.setData(patch);
    } catch (err) {
      /* 静默：点赞卡片不该因为这一下拉不到就弹错误 */
    }
  },

  /**
   * 拉某一场的点赞数据（不传 sessionId = 当前这一场）
   *
   * 一次拿到：这一场的候选菜 + 我投了哪些 + 这一场合计 + 跨场次累计。
   * 注意这个卡片**不受点单截止时间影响**：点赞本来就是吃完才做的事。
   */
  async loadVotes(silent, sessionId) {
    try {
      const res = await api.call('votes', sessionId ? { sessionId: sessionId } : {});
      const maxVotes = Number(res.maxVotes) || 3;
      this.pickVotes = (res.myVotes || []).slice(0, maxVotes);
      this.setData({
        voteSessionId: (res.session && res.session.sessionId) || '',
        voteSession: res.session || null,
        isCurrentVote: !!res.isCurrent,
        voteCandidates: res.candidates || [],
        myVotes: res.myVotes || [],
        myVoteText: (res.myVoteNames || []).join('、'),
        voterCount: Number(res.voterCount) || 0,
        maxVotes: maxVotes,
        likeMap: res.likeMap || {},
        likeMapAll: res.likeMapAll || {}
      });
      this.buildVoteList();
      if (this.data.dishes.length) this.buildShown(); // 菜品行上的 👍N 要跟着刷新
    } catch (err) {
      if (!silent) api.toastErr(err);
    }
  },

  /** 切换到另一场（我参加过的某一次）去点赞 */
  async onPickSession(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.voteSessionId) return;
    api.loading('切换中');
    await this.loadVotes(true, id);
    api.hideLoading();
  },

  /** 候选菜 + 当前勾选 → 渲染列表 */
  buildVoteList() {
    const picked = this.pickVotes || [];
    const list = (this.data.voteCandidates || []).map((c) =>
      Object.assign({}, c, { picked: picked.indexOf(c.dishId) >= 0 })
    );
    this.setData({ voteList: list, pickCount: picked.length });
  },

  onTapVote(e) {
    const id = e.currentTarget.dataset.id;
    const max = this.data.maxVotes || 3;
    const pick = (this.pickVotes || []).slice();
    const at = pick.indexOf(id);
    if (at >= 0) {
      pick.splice(at, 1);
    } else {
      if (pick.length >= max) return api.toast('最多给 ' + max + ' 道菜点赞，先取消一个吧');
      pick.push(id);
    }
    this.pickVotes = pick;
    this.buildVoteList();
  },

  async onSubmitVotes() {
    const pick = this.pickVotes || [];
    if (!pick.length) return api.toast('先点几道你觉得好吃的菜');
    api.loading('提交中');
    try {
      const res = await api.call('submitVotes', { dishIds: pick, sessionId: this.data.voteSessionId });
      api.hideLoading();
      await this.loadVotes(true, this.data.voteSessionId);
      this.loadDinners();
      const label = (res.session && res.session.name) || '';
      api.toast('谢谢！已给「' + label + '」的 ' + res.count + ' 道菜点赞', 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async onClearVotes() {
    const name = (this.data.voteSession && this.data.voteSession.name) || '这一场';
    const ok = await api.confirm('撤销我在「' + name + '」点的赞？');
    if (!ok) return;
    api.loading('处理中');
    try {
      await api.call('submitVotes', { dishIds: [], sessionId: this.data.voteSessionId });
      api.hideLoading();
      await this.loadVotes(true, this.data.voteSessionId);
      this.loadDinners();
      api.toast('已撤销');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /* -------------------- 数据加载 -------------------- */

  async bootstrap(force) {
    this.setData({ loading: true });
    try {
      const session = await app.ensureSession(!!force);
      this.setData({ isAdmin: !!session.isAdmin });

      if (!session.inited) {
        this.setData({ loading: false, inited: false, cfg: null, dishes: [], shown: [], cartCount: 0 });
        this._loaded = true;
        return;
      }

      this.applyConfig(session.config);

      const [menuRes, mineRes] = await Promise.all([api.call('listDishes'), api.call('myOrder')]);
      const dishes = menuRes.dishes || [];
      const cats = this.buildCats(dishes);

      this.setData({ inited: true, dishes, cats, viewCat: '全部', loading: false });
      this._loaded = true;
      this.startDeadlineTick();
      this.loadVotes(true); // 菜品行上的 👍N：失败也不打扰朋友（静默）

      if (mineRes.order) {
        this.fillFromOrder(mineRes.order);
      } else {
        this.cart = {};
        this.notes = {};
        this.setData({ myOrder: null });
        this.buildShown();
      }
    } catch (err) {
      this._loaded = true;
      this.setData({ loading: false });
      api.toastErr(err);
    }
  },

  applyConfig(cfg) {
    const deadlineTs = cfg && cfg.deadlineTs ? Number(cfg.deadlineTs) : 0;
    this.setData({
      cfg: cfg || null,
      deadlineText: deadlineTs ? fmt.fmtShort(deadlineTs) + '（' + fmt.countdown(deadlineTs) + '）' : '不限时间，随时可点',
      closed: !!(deadlineTs && Date.now() > deadlineTs)
    });
  },

  syncDeadline() {
    const cfg = app.globalData.cfg || this.data.cfg;
    if (cfg) this.applyConfig(cfg);
  },

  fillFromOrder(order) {
    this.cart = {};
    this.notes = {};
    (order.items || []).forEach((it) => {
      this.cart[it.dishId] = Number(it.qty) || 0;
      if (it.note) this.notes[it.dishId] = it.note;
    });
    const nick = order.nick || wx.getStorageSync('nick') || '';
    this.setData(
      {
        myOrder: order,
        nick,
        partySize: Number(order.partySize) || 2,
        arriveAt: order.arriveAt || '',
        note: order.note || ''
      },
      () => this.buildShown()
    );
  },

  /**
   * 分类标签数据。带上"这一类有几道菜"——标签上有数字，才更像导航而不是一排装饰。
   */
  buildCats(dishes) {
    const cats = [{ name: '全部', count: dishes.length }];
    const index = {};
    dishes.forEach((d) => {
      if (!index[d.category]) {
        index[d.category] = { name: d.category, count: 0 };
        cats.push(index[d.category]);
      }
      index[d.category].count += 1;
    });
    return cats;
  },

  /** 一个菜品 → 一行渲染数据 */
  dishRow(d) {
    return {
      key: 'd:' + d._id,
      type: 'dish',
      _id: d._id,
      name: d.name,
      emoji: d.emoji || '🍽',
      desc: d.desc || '',
      category: d.category,
      tags: d.tags || [],
      limit: d.limit,
      // 多少人点赞（**跨场次累计**：来过三次都说好的菜，新朋友一眼就看得到）
      likeText: (this.data.likeMapAll || {})[d._id] ? '👍 ' + this.data.likeMapAll[d._id] : '',
      qty: this.cart[d._id] || 0,
      note: this.notes[d._id] || ''
    };
  },

  /** 根据分类 + 购物车生成渲染列表 */
  buildShown() {
    const { dishes, activeCat } = this.data;

    // 先清掉购物车里"已经不在本次菜单上"的菜。
    // 必须在这里做：fillFromOrder 是按订单灌回购物车的，如果那之后主人下架了某道菜，
    // 购物车里会留着一个界面上不渲染的条目——底部计数会多算，提交时被服务端拒绝，
    // 而朋友在界面上根本找不到那一行去减掉它。
    const valid = {};
    dishes.forEach((d) => {
      valid[d._id] = true;
    });
    Object.keys(this.cart).forEach((id) => {
      if (!valid[id]) {
        delete this.cart[id];
        delete this.notes[id];
      }
    });

    const shown = [];
    const headerNames = [];

    if (activeCat === '全部') {
      // 关键：按分类分组、并在中间插入分组标题。
      // 否则一路往下划，所有菜连成一片，看不出哪道菜属于哪一类。
      const order = [];
      const byCat = {};
      dishes.forEach((d) => {
        if (!byCat[d.category]) {
          byCat[d.category] = [];
          order.push(d.category);
        }
        byCat[d.category].push(d);
      });
      order.forEach((cat) => {
        headerNames.push(cat);
        shown.push({ key: 'h:' + cat, type: 'header', name: cat, count: byCat[cat].length });
        byCat[cat].forEach((d) => shown.push(this.dishRow(d)));
      });
    } else {
      dishes.filter((d) => d.category === activeCat).forEach((d) => shown.push(this.dishRow(d)));
    }

    // 分组标题的名字按顺序记下来：量位置时返回的节点顺序和它一一对应
    this._headerNames = headerNames;

    // 合计必须按整个购物车算：只算当前分类的话，切到别的分类底部会错误显示"已点 0 道"
    const cartCount = Object.keys(this.cart).reduce((s, id) => s + (this.cart[id] || 0), 0);
    this.setData({ shown, cartCount }, () => this.measureSections());
  },

  /* -------------------- 交互 -------------------- */

  onCat(e) {
    const cat = e.currentTarget.dataset.cat;
    // 点标签 = 切过滤模式（只看这一类）；高亮同步过去
    this.setData({ activeCat: cat, viewCat: cat }, () => this.buildShown());
  },

  onPlus(e) {
    if (this.data.closed) return api.toast('点单已经截止啦');
    const id = e.currentTarget.dataset.id;
    const next = Math.min(20, (this.cart[id] || 0) + 1);
    this.cart[id] = next;
    const max = Number((this.data.cfg && this.data.cfg.maxDishesPerOrder) || 0);
    if (max > 0) {
      const total = Object.keys(this.cart).reduce((s, k) => s + this.cart[k], 0);
      if (total > max) {
        this.cart[id] = next - 1;
        this.buildShown();
        return api.toast('每单最多点 ' + max + ' 道菜');
      }
    }
    this.buildShown();
  },

  onMinus(e) {
    const id = e.currentTarget.dataset.id;
    const next = Math.max(0, (this.cart[id] || 0) - 1);
    if (next === 0) {
      delete this.cart[id];
      delete this.notes[id];
    } else {
      this.cart[id] = next;
    }
    this.buildShown();
  },

  onNote(e) {
    const id = e.currentTarget.dataset.id;
    const v = String(e.detail.value || '');
    if (v) this.notes[id] = v;
    else delete this.notes[id];
  },

  onClearCart() {
    api.confirm('清空当前已选的菜？（已提交的单不受影响）').then((ok) => {
      if (!ok) return;
      this.cart = {};
      this.notes = {};
      this.buildShown();
    });
  },

  onOpenSubmit() {
    // 页面可能已经开了很久，先用"现在"重新判定一次截止状态再决定要不要弹窗
    this.syncDeadline();
    if (this.data.closed) return api.toast('点单已经截止啦');
    if (!this.data.cartCount) return api.toast('还没点菜呢，先点两道～');
    const nick = this.data.nick || wx.getStorageSync('nick') || '';
    this.setData({ showSubmit: true, nick });
  },

  onCloseSubmit() {
    this.setData({ showSubmit: false });
  },

  onNickInput(e) {
    this.setData({ nick: e.detail.value });
  },

  onArriveInput(e) {
    this.setData({ arriveAt: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  onPartyPlus() {
    this.setData({ partySize: Math.min(30, this.data.partySize + 1) });
  },

  onPartyMinus() {
    this.setData({ partySize: Math.max(1, this.data.partySize - 1) });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const nick = String(this.data.nick || '').trim();
    if (!nick) return api.toast('先写个称呼吧，主人要知道是谁点的');

    const items = Object.keys(this.cart)
      .filter((id) => this.cart[id] > 0)
      .map((id) => {
        const dish = this.data.dishes.find((d) => d._id === id) || {};
        return {
          dishId: id,
          name: dish.name || '',
          emoji: dish.emoji || '',
          qty: this.cart[id],
          note: this.notes[id] || ''
        };
      });

    if (!items.length) return api.toast('至少点一道菜');

    this.setData({ submitting: true });
    api.loading('提交中');
    const wasExisting = !!(this.data.myOrder && this.data.myOrder.createdAt);
    try {
      await api.call('submitOrder', {
        nick,
        partySize: this.data.partySize,
        arriveAt: this.data.arriveAt,
        note: this.data.note,
        items
      });
      wx.setStorageSync('nick', nick);
      const mine = await api.call('myOrder');
      api.hideLoading();
      this.setData({ showSubmit: false, submitting: false });
      if (mine.order) this.fillFromOrder(mine.order);
      if (this.data.boardOpen) this.loadBoard(true); // 自己刚提交，顺手刷新"大家都在点什么"
      api.toast(wasExisting ? '已更新你的点单' : '点单成功！', 'success');
    } catch (err) {
      api.hideLoading();
      this.setData({ submitting: false });
      api.toastErr(err);
    }
  },

  async onInitAsHost() {
    const ok = await api.confirm('你确定是这次家宴的主人吗？开通后你会成为管理员。');
    if (!ok) return;
    api.loading('开通中');
    try {
      await api.call('init', {});
      const session = await app.refreshSession();
      api.hideLoading();
      this.bootstrap(true);

      const code = (session && session.config && session.config.hostCode) || '';
      wx.showModal({
        title: '开通成功',
        content:
          '主人口令：' + code + '\n\n（配偶输这个口令也能成为主人，一起看汇总）\n\n接下来去「家宴设置与菜库」导入菜库、勾选今晚的菜。',
        confirmText: '去设置菜库',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) this.goMenu();
        }
      });
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  goDashboard() {
    wx.navigateTo({ url: '/pages/admin/dashboard/dashboard' });
  },

  goMenu() {
    wx.navigateTo({ url: '/pages/admin/menu/menu' });
  }
});
