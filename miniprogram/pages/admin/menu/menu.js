const api = require('../../../utils/api.js');
const fmt = require('../../../utils/format.js');
const SEED = require('../../../data/dishes.seed.js');

const app = getApp();

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
    seedCount: SEED.length
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

      const deadlineTs = Number(cfg.deadlineTs) || 0;
      this.setData({
        loading: false,
        isAdmin: true,
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
    } catch (err) {
      this.setData({ loading: false });
      api.toastErr(err);
    }
  },

  buildGroups() {
    const dishes = this.all || [];
    const order = [];
    const map = {};
    dishes.forEach((d) => {
      if (!map[d.category]) {
        map[d.category] = [];
        order.push(d.category);
      }
      map[d.category].push(d);
    });
    const groups = order.map((c) => ({
      category: c,
      dishes: map[c],
      onCount: map[c].filter((d) => d.available).length
    }));
    const onCount = dishes.filter((d) => d.available).length;
    this.setData({ groups, total: dishes.length, onCount, offCount: dishes.length - onCount });
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
