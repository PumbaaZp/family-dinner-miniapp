const api = require('../../../utils/api.js');
const fmt = require('../../../utils/format.js');
const P = require('../../../utils/pantry.js');
const SEED = require('../../../data/dishes.seed.js');

const app = getApp();

/**
 * 已经废弃的宽泛分类：它们按"做起来快不快 / 上菜顺序"分，不按"是什么"（主料/形态）分，
 * 跟猪肉/蔬菜/主食是两回事，点菜时既猜不到菜在哪一类，又会跟别的分类重复。
 * 留着这个名单只为「一次性整理」能把线上库里残留的它们挪走。
 */
const RETIRED_CATEGORIES = ['热菜', '快手菜'];

/**
 * 内置菜库里**换过图标**的菜：线上库还挂着老图标的话，「一次性整理」会同步一次。
 * 只认这个白名单 —— 你自己用 ✎ 改过的图标绝不动。
 */
const SEED_ICON_SYNC = ['干煸四季豆'];

Page({
  data: {
    loading: true,
    isAdmin: false,
    groups: [],
    total: 0,
    onCount: 0,
    offCount: 0,

    form: { title: '', host: '', address: '', notice: '', maxDishesPerOrder: 0 },
    dateStr: '',
    timeStr: '',
    deadlineText: '不限时间',
    currentDeadlineTs: 0,
    enableDeadline: false,
    hostCode: '',
    seedCount: SEED.length,
    // 库存概览：菜谱里的菜有几道"家里食材够做"
    pantryCount: 0,
    canCookCount: 0,
    // 客人的点赞（挑下次菜单的参考）
    topLikes: [],
    likedDishCount: 0,
    // 编辑菜品（临时加的菜、分类放错的菜，都用它改）
    editing: null,
    editForm: { name: '', desc: '', emoji: '', ingredients: '', tags: '' },
    editCatIndex: 0,
    catOptions: [],
    // 分类整理（把「热菜」这类太宽泛的分类收拾掉）
    tidyOpen: false,
    tidyCats: [],
    tidyFromIndex: 0,
    tidyFrom: '',
    tidyOptions: [],
    tidyToIndex: 0,
    tidyTo: '',
    tidyPlan: '',
    tidyBusy: false
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const session = await app.ensureSession(true);
      if (!session.isAdmin) {
        this.setData({ loading: false });
        api.toast('只有主人能进这里');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const cfg = session.config || {};
      const res = await api.call('listDishes', { all: true });
      this.all = res.dishes || [];

      // 库存读不到不致命（最常见的场景是云函数还没重新部署，没有 listPantry 这个 action），
      // 菜单页必须照常能用，所以单独兜住。
      let pantryCount = 0;
      let pantryFailed = false;
      try {
        const pantry = await api.call('listPantry');
        this.pantryNameMap = P.toNameMap(pantry.items || []);
        pantryCount = (pantry.stats && pantry.stats.total) || (pantry.items || []).length;
      } catch (e) {
        this.pantryNameMap = {};
        pantryFailed = true;
      }

      // 客人的点赞同样兜住：挑下次的菜单时，"老朋友都说好"是最有用的参考。
      // 用 **跨场次累计**（去过几次就投几次票），而不是本场的票数。
      let likes = [];
      try {
        const voteRes = await api.call('votes');
        likes = voteRes.totalsAll || voteRes.totals || [];
      } catch (e) {
        likes = [];
      }
      this.likeMap = {};
      likes.forEach((l) => {
        this.likeMap[l.dishId] = l.count;
      });

      const deadlineTs = Number(cfg.deadlineTs) || 0;
      this.setData({
        loading: false,
        isAdmin: true,
        pantryCount: pantryCount,
        topLikes: likes.slice(0, 5).map((l) => l.name + '（' + l.count + '）'),
        likedDishCount: likes.length,
        form: {
          title: cfg.title || '',
          host: cfg.host || '',
          address: cfg.address || '',
          notice: cfg.notice || '',
          maxDishesPerOrder: Number(cfg.maxDishesPerOrder) || 0
        },
        dateStr: fmt.toDateStr(deadlineTs || Date.now() + 86400000),
        timeStr: fmt.toTimeStr(deadlineTs || Date.now() + 86400000),
        deadlineText: deadlineTs ? fmt.fmtFull(deadlineTs) + '（' + fmt.countdown(deadlineTs) + '）' : '不限时间',
        hostCode: cfg.hostCode || '',
        currentDeadlineTs: deadlineTs,
        // 截止时间是"显式开启"的：没设过就是关着，避免只改标题也被塞进一个截止时间
        enableDeadline: deadlineTs > 0
      });
      this.buildGroups();
      if (pantryFailed) api.toast('没读到库存：云函数可能还没重新部署');
    } catch (err) {
      this.setData({ loading: false });
      api.toastErr(err);
    }
  },

  /**
   * 分组渲染。顺手算一下每道菜"家里的食材够不够"——
   * 挑菜的时候最想知道的就是这个：缺两样的先别上架。
   */
  buildGroups() {
    const dishes = this.all || [];
    const haveMap = this.pantryNameMap || {};
    // 库存是空的（或者没读到）就一律不显示"缺几样"：
    // 否则每道菜都挂一句"缺 3 样"，纯噪音，还会让人以为库存数据丢了。
    const hasPantry = Object.keys(haveMap).length > 0;
    const order = [];
    const map = {};
    let canCook = 0;

    dishes.forEach((d) => {
      const cov = P.coverage(d, haveMap);
      const likeCount = (this.likeMap || {})[d._id] || 0;
      if (cov.full) canCook += 1;
      const row = Object.assign({}, d, {
        haveShort: hasPantry ? P.coverageShort(cov) : '',
        haveFull: cov.full,
        missingCount: cov.missing.length,
        ingTotal: cov.total,
        likeCount: likeCount,
        likeText: likeCount ? '👍 ' + likeCount : ''
      });
      if (!map[d.category]) {
        map[d.category] = [];
        order.push(d.category);
      }
      map[d.category].push(row);
    });

    const groups = order.map((c) => ({
      category: c,
      dishes: map[c],
      onCount: map[c].filter((d) => d.available).length
    }));
    const onCount = dishes.filter((d) => d.available).length;
    this.setData({
      groups,
      total: dishes.length,
      onCount,
      offCount: dishes.length - onCount,
      canCookCount: canCook
    });
  },

  goPantry() {
    wx.navigateTo({ url: '/pages/admin/pantry/pantry' });
  },

  /* ---------- 分类整理（合并 / 拆到更具体的分类） ---------- */

  /**
   * 打开「分类整理」面板
   *
   * 用途：把太宽泛的分类收拾掉。典型是「热菜」—— 红烧肉、清蒸鲈鱼、可乐鸡翅
   * 都能算热菜，跟"猪肉/鱼类/鸡肉"这些分类重复，点菜时要划半天。
   * 点一下这个分类，就能把底下的菜一次挪走（可以整体挪到一个分类，
   * 也可以按菜名自动归类），挪完那个分类自己就消失了。
   */
  onTidyCategories() {
    const cats = this.catStats();
    if (cats.length < 2) return api.toast('现在只有一个分类，没什么好整理的');
    this.setData({
      tidyOpen: true,
      tidyCats: cats,
      tidyFromIndex: 0,
      tidyFrom: cats[0].name,
      tidyOptions: ['按菜名自动归类'].concat(cats.map((c) => c.name)).filter((n) => n !== cats[0].name),
      tidyToIndex: 0,
      tidyTo: '',
      tidyPlan: '',
      tidyBusy: false
    });
    this.previewTidy();
  },

  /** 每个分类有几道菜（整理面板的第一级选择；带 label 是给 picker 显示的） */
  catStats() {
    const map = {};
    const order = [];
    (this.all || []).forEach((d) => {
      const c = d.category || '自定义';
      if (!map[c]) {
        map[c] = { name: c, label: c, count: 0, on: 0 };
        order.push(c);
      }
      map[c].count += 1;
      if (d.available) map[c].on += 1;
    });
    return order.map((c) => {
      map[c].label = c + '（' + map[c].count + ' 道，已上架 ' + map[c].on + '）';
      return map[c];
    });
  },

  onTidyFromChange(e) {
    const i = Number(e.detail.value) || 0;
    const from = this.data.tidyCats[i] ? this.data.tidyCats[i].name : '';
    const options = ['按菜名自动归类'].concat(this.data.tidyCats.map((c) => c.name)).filter((n) => n !== from);
    this.setData({ tidyFromIndex: i, tidyFrom: from, tidyOptions: options, tidyToIndex: 0, tidyTo: '' });
    this.previewTidy(from, '');
  },

  onTidyToChange(e) {
    const i = Number(e.detail.value) || 0;
    const to = i === 0 ? '' : this.data.tidyOptions[i];
    this.setData({ tidyToIndex: i, tidyTo: to });
    this.previewTidy(this.data.tidyFrom, to);
  },

  /** 先出方案给主人看一眼（dryRun，不动数据） */
  async previewTidy(from, to) {
    const f = from === undefined ? this.data.tidyFrom : from;
    const t = to === undefined ? this.data.tidyTo : to;
    if (!f) return;
    this.setData({ tidyBusy: true });
    try {
      const res = await api.call('mergeCategory', { from: f, to: t || '', dryRun: true });
      const lines = (res.plan || []).map((p) => '· ' + p.name + ' → ' + p.to);
      const head = res.plan && res.plan.length
        ? '把「' + f + '」下的 ' + res.plan.length + ' 道菜挪走：'
        : '「' + f + '」里没有能自动归类的菜（可以手动选一个目标分类）';
      const tail = (res.unmapped || []).length ? '\n\n没建议（会留在原分类）：' + res.unmapped.join('、') : '';
      this.setData({ tidyPlan: head + '\n\n' + lines.join('\n') + tail, tidyBusy: false });
    } catch (err) {
      this.setData({ tidyBusy: false, tidyPlan: '' });
      api.toastErr(err);
    }
  },

  onTidyCancel() {
    this.setData({ tidyOpen: false, tidyPlan: '' });
  },

  /**
   * 一键「一次性整理」：把已经废弃的宽泛分类挪走 + 同步内置菜库里改过的图标
   *
   * 为什么要做成一个按钮：主人不想一道道收拾。
   *   - 分类：`热菜` / `快手菜` 这两个都不按"是什么"分，已经废弃。
   *     这里直接调 `mergeCategory`（按菜名自动归类）把它们挪进具体分类，
   *     跟手动点「分类整理」走的是同一套服务端逻辑，只是不用选来选去。
   *   - 图标：内置菜库里改过图标的菜（见 SEED_ICON_SYNC），线上库如果还是老图标就同步一次。
   *     只动这个白名单里的菜，绝不覆盖你自己用 ✎ 改过的图标。
   *
   * 幂等：再点一次基本就是"没有需要整理的"。
   */
  async onOneTimeFix() {
    const cats = this.catStats();
    const retired = RETIRED_CATEGORIES.filter((c) => cats.some((x) => x.name === c));
    const icons = this.iconFixes();
    if (!retired.length && !icons.length) {
      return api.toast('没有需要整理的了（老分类和图标都是最新的）');
    }

    const lines = [];
    if (retired.length) lines.push('· 把「' + retired.join('」「') + '」下的菜按菜名归类到猪肉/蔬菜/主食等具体分类');
    icons.forEach((f) => lines.push('· 改图标：' + f.name + ' ' + f.from + ' → ' + f.to));
    const ok = await api.confirm('一次性整理（只改分类和图标，不动菜名/食材/上架状态）：\n\n' + lines.join('\n'));
    if (!ok) return;

    api.loading('整理中');
    try {
      let moved = 0;
      const left = [];
      for (const from of retired) {
        const res = await api.call('mergeCategory', { from: from });
        moved += Number(res.moved) || 0;
        (res.unmapped || []).forEach((n) => left.push(n));
      }
      for (const f of icons) {
        await api.call('updateDish', { id: f.id, patch: { emoji: f.to } });
      }
      api.hideLoading();
      await this.load();
      const parts = [];
      if (moved) parts.push('挪了 ' + moved + ' 道菜');
      if (icons.length) parts.push('改了 ' + icons.length + ' 个图标');
      if (left.length) parts.push('有 ' + left.length + ' 道没建议出来（用「分类整理」手动选个分类）：' + left.join('、'));
      api.toast(parts.length ? '整理好了：' + parts.join('；') : '没有需要整理的');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /** 线上库 vs 内置菜库：哪些菜的图标该同步（只认白名单，不动你自己改过的图标） */
  iconFixes() {
    const byName = {};
    (this.all || []).forEach((d) => {
      byName[d.name] = d;
    });
    const out = [];
    SEED_ICON_SYNC.forEach((name) => {
      const mine = SEED.filter((s) => s.name === name)[0];
      const db = byName[name];
      if (mine && db && db.emoji !== mine.emoji) {
        out.push({ id: db._id, name: name, from: db.emoji || '（空）', to: mine.emoji });
      }
    });
    return out;
  },

  /** 真的动数据：整理完刷新菜库 */
  async onTidyConfirm() {
    const from = this.data.tidyFrom;
    const to = this.data.tidyTo;
    if (!from) return;
    const ok = await api.confirm(
      '把「' + from + '」下的菜' + (to ? '全部挪到「' + to + '」' : '按菜名自动归类') + '？\n\n只改分类，菜名、食材、上架状态都不动。'
    );
    if (!ok) return;
    api.loading('整理中');
    try {
      const res = await api.call('mergeCategory', { from: from, to: to || '' });
      api.hideLoading();
      this.setData({ tidyOpen: false, tidyPlan: '' });
      await this.load();
      api.toast('已挪走 ' + res.moved + ' 道菜');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /** 点菜名旁边的"缺 N 样"，看具体缺哪几样 */
  onShowCoverage(e) {
    const id = e.currentTarget.dataset.id;
    const dish = (this.all || []).filter((d) => d._id === id)[0];
    if (!dish) return;
    const cov = P.coverage(dish, this.pantryNameMap || {});
    wx.showModal({
      title: dish.name,
      content: P.coverageDetail(dish.name, cov),
      confirmText: '去补库存',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) this.goPantry();
      }
    });
  },

  /* ---------- 菜库 ---------- */

  async onToggleDish(e) {
    const id = e.currentTarget.dataset.id;
    const available = !!e.detail.value;
    try {
      await api.call('toggleDish', { id, available });
      this.all = this.all.map((d) => (d._id === id ? Object.assign({}, d, { available }) : d));
      this.buildGroups();
    } catch (err) {
      api.toastErr(err);
      this.buildGroups();
    }
  },

  async onToggleCategory(e) {
    const cat = e.currentTarget.dataset.cat;
    const group = this.data.groups.find((g) => g.category === cat);
    if (!group) return;
    const target = group.onCount !== group.dishes.length; // 有未上架的 → 全部上架
    const ids = group.dishes.map((d) => d._id);
    api.loading('处理中');
    try {
      await api.call('batchToggle', { ids, available: target });
      this.all = this.all.map((d) => (d.category === cat ? Object.assign({}, d, { available: target }) : d));
      api.hideLoading();
      this.buildGroups();
      api.toast(cat + ' 已' + (target ? '全部上架' : '全部下架'));
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async onAllOn() {
    await this.batchAll(true);
  },

  async onAllOff() {
    await this.batchAll(false);
  },

  async batchAll(available) {
    const ok = await api.confirm(available ? '把 36 道菜全部上架？朋友会看到完整菜库。' : '全部下架？朋友端会变成空菜单。');
    if (!ok) return;
    api.loading('处理中');
    try {
      const res = await api.call('batchToggle', { available });
      this.all = this.all.map((d) => Object.assign({}, d, { available }));
      api.hideLoading();
      this.buildGroups();
      api.toast('已更新 ' + (res.updated || 0) + ' 道');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async onLimitEdit(e) {
    const id = e.currentTarget.dataset.id;
    const raw = String(e.detail.value || '').trim();
    const limit = raw === '' ? null : Math.max(1, Math.min(99, parseInt(raw, 10) || 1));
    try {
      await api.call('updateDish', { id, patch: { limit } });
      this.all = this.all.map((d) => (d._id === id ? Object.assign({}, d, { limit }) : d));
      this.buildGroups();
      api.toast(limit ? '限量 ' + limit + ' 份' : '已取消限量');
    } catch (err) {
      api.toastErr(err);
    }
  },

  async onDeleteDish(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const ok = await api.confirm('删除「' + name + '」？');
    if (!ok) return;
    try {
      await api.call('removeDish', { id });
      this.all = this.all.filter((d) => d._id !== id);
      this.buildGroups();
      api.toast('已删除');
    } catch (err) {
      api.toastErr(err);
    }
  },

  async onAddDish() {
    const name = await api.prompt('菜名', '新增菜品', '例如：葱烧海参');
    if (!name) return;
    try {
      await api.call('addDish', { name, category: '自定义', available: true });
      await this.load();
      api.toast('已添加', 'success');
    } catch (err) {
      api.toastErr(err);
    }
  },

  async onImportSeed() {
    const ok = await api.confirm('导入内置的 ' + SEED.length + ' 道家常菜？已存在的同名菜不会被覆盖。');
    if (!ok) return;
    api.loading('导入中');
    try {
      const res = await api.call('seedDishes', { dishes: SEED });
      api.hideLoading();
      await this.load();
      wx.showModal({
        title: '导入完成',
        content: '新增 ' + res.added + ' 道，跳过已存在 ' + (res.total - res.added) + ' 道。默认上架了 14 道经典家宴菜，你可以逐道勾选调整。',
        showCancel: false
      });
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async onResetSeed() {
    const ok = await api.confirm('用内置菜库覆盖同名菜（名称、描述、限量、上架状态都会还原）？自定义菜不受影响。');
    if (!ok) return;
    api.loading('重置中');
    try {
      const res = await api.call('seedDishes', { dishes: SEED, overwrite: true });
      api.hideLoading();
      await this.load();
      api.toast('已重置 ' + res.updated + ' 道');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /* ---------- 编辑菜品 ---------- */

  /**
   * 打开编辑面板
   *
   * 为什么需要：临时加的菜（「+ 新增」）只填了一个名字、分类固定是「自定义」，
   * 之后想补简介、换分类、写食材，界面上一直没有入口。这里补上。
   */
  onEditDish(e) {
    const id = e.currentTarget.dataset.id;
    const dish = (this.all || []).filter((d) => d._id === id)[0];
    if (!dish) return;

    // 分类下拉 = 菜库里已有的分类（+ 排在最前的「自定义」和「其他」）
    const used = [];
    (this.all || []).forEach((d) => {
      if (d.category && used.indexOf(d.category) < 0) used.push(d.category);
    });
    const catOptions = ['自定义'].concat(used.filter((c) => c !== '自定义'));
    if (used.indexOf('其他') < 0) catOptions.push('其他');

    this.setData({
      editing: { _id: dish._id, name: dish.name, available: !!dish.available, limit: dish.limit },
      editForm: {
        name: dish.name || '',
        desc: dish.desc || '',
        emoji: dish.emoji || '',
        ingredients: (dish.ingredients || []).join('、'),
        tags: (dish.tags || []).join('、')
      },
      editCatIndex: Math.max(0, catOptions.indexOf(dish.category || '自定义')),
      catOptions: catOptions
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  onEditInput(e) {
    const key = e.currentTarget.dataset.key;
    const form = Object.assign({}, this.data.editForm);
    form[key] = e.detail.value;
    this.setData({ editForm: form });
  },

  onEditCatChange(e) {
    this.setData({ editCatIndex: Number(e.detail.value) || 0 });
  },

  onCancelEdit() {
    this.setData({ editing: null, editForm: { name: '', desc: '', emoji: '', ingredients: '', tags: '' } });
  },

  async onSaveDish() {
    const editing = this.data.editing;
    if (!editing) return;
    const form = this.data.editForm;
    const name = String(form.name || '').trim();
    if (!name) return api.toast('菜名不能为空');

    // 「、」「,」「，」和空格都当分隔符，跟库存页的批量粘贴保持一致的直觉
    const split = (s) =>
      String(s || '')
        .split(/[,，、;；\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 10);

    const category = this.data.catOptions[this.data.editCatIndex] || '自定义';
    api.loading('保存中');
    try {
      await api.call('updateDish', {
        id: editing._id,
        patch: {
          name: name,
          category: category,
          desc: String(form.desc || '').trim(),
          emoji: String(form.emoji || '').trim() || '🍽',
          ingredients: split(form.ingredients),
          tags: split(form.tags).slice(0, 5)
        }
      });
      api.hideLoading();
      this.onCancelEdit();
      await this.load();
      api.toast('已保存：' + name + '（' + category + '）', 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /* ---------- 家宴设置 ---------- */

  onFormInput(e) {
    const key = e.currentTarget.dataset.key;
    const form = Object.assign({}, this.data.form);
    form[key] = e.detail.value;
    this.setData({ form });
  },

  onDateChange(e) {
    this.setData({ dateStr: e.detail.value });
  },

  /**
   * 只给已有菜补食材（上架状态、限量、自定义描述都不动）
   *
   * 为什么需要它：菜库是老数据时，里面的菜没有 ingredients 字段，
   * 而「导入内置菜库」只补新增、不覆盖已有菜——点它拿不到食材。
   * 用「重置为默认」又会把上架状态一起还原，所以单独给一个非破坏性的入口。
   */
  async onFillIngredients() {
    const ok = await api.confirm('给菜库里已有的菜补上食材？\n\n只写「食材」这一项，不会动你的上架状态、限量、改过的描述。');
    if (!ok) return;
    api.loading('补全中');
    try {
      const res = await api.call('seedDishes', { dishes: SEED, ingredientsOnly: true });
      api.hideLoading();
      await this.load();
      wx.showModal({
        title: '补全完成',
        content: '补了 ' + res.ingredientsFilled + ' 道菜的食材' + (res.added ? '，另外新增 ' + res.added + ' 道（如「小米南瓜粥」）' : '') + '。\n\n去「后厨看板」就能看到食材采购清单了。',
        showCancel: false
      });
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  onTimeChange(e) {
    this.setData({ timeStr: e.detail.value });
  },

  onToggleDeadline(e) {
    const on = !!e.detail.value;
    this.setData({ enableDeadline: on });
    if (on && !this.data.currentDeadlineTs) {
      api.toast('选好日期和时间后，点「保存设置」才会生效');
    }
  },

  async onSaveSettings() {
    const form = this.data.form;
    // 关键：开关没打开就一律保存 0（不限时间），
    // 不能直接用选择器的值——它默认是"明天此刻"，会把只想改标题的主人坑到
    const deadlineTs = fmt.deadlineForSave(this.data.enableDeadline, this.data.dateStr, this.data.timeStr);

    if (fmt.isPastDeadline(deadlineTs)) {
      const go = await api.confirm('你选的截止时间已经过去了，保存后朋友会立刻无法点单。确定要这样设置吗？');
      if (!go) return;
    }

    api.loading('保存中');
    try {
      await api.call('updateConfig', {
        patch: {
          title: form.title,
          host: form.host,
          address: form.address,
          notice: form.notice,
          maxDishesPerOrder: Number(form.maxDishesPerOrder) || 0,
          deadlineTs
        }
      });
      await app.refreshSession();
      api.hideLoading();
      this.setData({
        currentDeadlineTs: deadlineTs,
        enableDeadline: deadlineTs > 0,
        deadlineText: deadlineTs ? fmt.fmtFull(deadlineTs) + '（' + fmt.countdown(deadlineTs) + '）' : '不限时间'
      });
      api.toast(deadlineTs ? '已保存，' + fmt.countdown(deadlineTs) + '截止' : '已保存（不设截止时间）', 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async onClearDeadline() {
    const ok = await api.confirm('取消截止时间？之后朋友随时都能点单和修改。');
    if (!ok) return;
    api.loading('保存中');
    try {
      await api.call('updateConfig', { patch: { deadlineTs: 0 } });
      await app.refreshSession();
      api.hideLoading();
      this.setData({ currentDeadlineTs: 0, enableDeadline: false, deadlineText: '不限时间' });
      api.toast('已取消截止时间');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  onCopyCode() {
    wx.setClipboardData({ data: this.data.hostCode });
  }
});
