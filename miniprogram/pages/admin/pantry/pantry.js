const api = require('../../../utils/api.js');
const P = require('../../../utils/pantry.js');

const app = getApp();

/**
 * 家里的库存（有哪些食材、调料）
 *
 * 刻意跟菜谱解耦：这里记的是"我家现在有什么"，不是"今晚要做什么"。
 * 两条数据只在两个地方碰头：
 *   ① 菜单页每道菜会显示"食材都有 / 缺 N 样"，方便照着存货挑菜
 *   ② 后厨看板的待购清单会把家里已有的划掉
 */
Page({
  data: {
    loading: true,
    isAdmin: false,

    groups: [],
    stats: { total: 0, food: 0, seasoning: 0, other: 0 },
    cats: P.CATS,

    // 新增 / 编辑表单
    form: { name: '', qty: '', note: '' },
    catIndex: 0,
    editing: '',

    // 从菜谱食材快速添加
    showQuick: false,
    chipFilter: '',
    quickChips: [],
    quickMissing: 0,
    ingredientCount: 0,
    dishCount: 0,

    // 批量粘贴
    showBulk: false,
    bulkText: ''
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
        api.toast('只有主人能看到家里的库存');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const [pantry, dishes] = await Promise.all([api.call('listPantry'), api.call('listDishes', { all: true })]);
      this.items = pantry.items || [];
      this.all = dishes.dishes || [];
      this.setData({ loading: false, isAdmin: true, dishCount: this.all.length });
      this.render();
    } catch (err) {
      this.setData({ loading: false });
      api.toastErr(err);
    }
  },

  /** 本地状态 → 渲染数据 */
  render() {
    const items = this.items || [];
    const haveMap = P.toNameMap(items);

    // 菜谱里出现过的所有食材（去重）——"从菜谱快速添加"用这份名单
    const seen = {};
    const names = [];
    (this.all || []).forEach((d) => {
      (d.ingredients || []).forEach((n) => {
        if (!n || seen[n]) return;
        seen[n] = true;
        names.push(n);
      });
    });

    const kw = String(this.data.chipFilter || '').trim();
    const chips = names
      .filter((n) => !kw || n.indexOf(kw) >= 0)
      .map((n) => ({ name: n, have: !!haveMap[n], cat: P.guessCat(n) }))
      // 还没有的排前面（正等着你点），已有的沉到最后
      .sort((a, b) => {
        if (a.have !== b.have) return a.have ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

    const stats = { total: items.length, food: 0, seasoning: 0, other: 0 };
    items.forEach((i) => {
      const cat = P.normalizeCat(i.cat);
      if (cat === '调料') stats.seasoning += 1;
      else if (cat === '其他') stats.other += 1;
      else stats.food += 1;
    });

    this.setData({
      groups: P.groupItems(items),
      stats: stats,
      quickChips: chips,
      quickMissing: chips.filter((c) => !c.have).length,
      ingredientCount: names.length
    });
  },

  /** 本地替换一条（避免每次点一下都重新拉整份清单） */
  putItem(item) {
    const next = (this.items || []).filter((i) => i.name !== item.name);
    next.push(item);
    this.items = P.sortItems(next);
  },

  /* ---------- 新增 / 编辑 ---------- */

  onFormInput(e) {
    const key = e.currentTarget.dataset.key;
    const form = Object.assign({}, this.data.form);
    form[key] = e.detail.value;
    this.setData({ form: form });
  },

  onCatChange(e) {
    this.setData({ catIndex: Number(e.detail.value) || 0 });
  },

  onPickItem(e) {
    const name = e.currentTarget.dataset.name;
    const it = (this.items || []).filter((i) => i.name === name)[0];
    if (!it) return;
    this.setData({
      editing: name,
      form: { name: it.name, qty: it.qty || '', note: it.note || '' },
      catIndex: Math.max(0, P.CATS.indexOf(P.normalizeCat(it.cat)))
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  onCancelEdit() {
    this.setData({ editing: '', form: { name: '', qty: '', note: '' }, catIndex: 0 });
  },

  async onAdd() {
    const form = this.data.form;
    const editing = this.data.editing;
    const name = String(editing || form.name || '').trim();
    if (!name) return api.toast('先写个名称吧');

    if (!editing && this.data.stats.total >= 300) {
      return api.toast('库存最多 300 项，先清理一些吧');
    }

    const cat = P.CATS[this.data.catIndex] || '食材';
    api.loading('保存中');
    try {
      await api.call('savePantryItems', { name: name, cat: cat, qty: form.qty, note: form.note });
      api.hideLoading();
      this.putItem({ name: name, cat: cat, qty: String(form.qty || '').trim(), note: String(form.note || '').trim() });
      this.setData({ editing: '', form: { name: '', qty: '', note: '' }, catIndex: 0 });
      this.render();
      api.toast(editing ? '已更新「' + name + '」' : '已加入「' + name + '」', 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  async onRemove(e) {
    const name = e.currentTarget.dataset.name;
    const ok = await api.confirm('把「' + name + '」从库存里删掉？');
    if (!ok) return;
    try {
      await api.call('removePantryItem', { name: name });
      this.items = (this.items || []).filter((i) => i.name !== name);
      if (this.data.editing === name) this.onCancelEdit();
      this.render();
      api.toast('已删除');
    } catch (err) {
      api.toastErr(err);
    }
  },

  async onClearAll() {
    const total = this.data.stats.total;
    if (!total) return;
    const ok = await api.confirm('清空全部 ' + total + ' 项库存？\n\n只是清掉"我家有什么"这份记录，菜库和订单不受影响。');
    if (!ok) return;
    api.loading('清空中');
    try {
      await api.call('clearPantry');
      api.hideLoading();
      this.items = [];
      this.onCancelEdit();
      this.render();
      api.toast('已清空');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  /* ---------- 从菜谱食材快速添加 ---------- */

  onToggleQuick() {
    this.setData({ showQuick: !this.data.showQuick });
  },

  onChipFilter(e) {
    this.data.chipFilter = e.detail.value;
    this.render();
  },

  /**
   * 点一下 = 家里有 / 没有。
   * 这是录入库存最省事的方式：菜谱里那九十多种食材直接照着点，
   * 比一个个打字快得多，而且名字跟菜谱完全一致，交叉比对不会因为错字失效。
   */
  async onToggleChip(e) {
    const name = e.currentTarget.dataset.name;
    const have = e.currentTarget.dataset.have === true;
    try {
      if (have) {
        await api.call('removePantryItem', { name: name });
        this.items = (this.items || []).filter((i) => i.name !== name);
        if (this.data.editing === name) this.onCancelEdit();
      } else {
        const cat = P.guessCat(name);
        await api.call('savePantryItems', { name: name, cat: cat });
        this.putItem({ name: name, cat: cat, qty: '', note: '' });
      }
      this.render();
    } catch (err) {
      api.toastErr(err);
    }
  },

  /* ---------- 批量粘贴 ---------- */

  onToggleBulk() {
    this.setData({ showBulk: !this.data.showBulk });
  },

  onBulkInput(e) {
    this.data.bulkText = e.detail.value;
  },

  async onBulkAdd() {
    const items = P.parseBulk(this.data.bulkText);
    if (!items.length) return api.toast('先粘几行进来，一行一样');
    const ok = await api.confirm('识别到 ' + items.length + ' 样：\n\n' + items.map((i) => i.name).join('、') + '\n\n加进库存？');
    if (!ok) return;
    api.loading('保存中');
    try {
      await api.call('savePantryItems', { items: items });
      api.hideLoading();
      items.forEach((i) => this.putItem({ name: i.name, cat: i.cat, qty: i.qty, note: '' }));
      this.setData({ bulkText: '' });
      this.render();
      api.toast('已加入 ' + items.length + ' 样', 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  onRefresh() {
    this.load();
  }
});
