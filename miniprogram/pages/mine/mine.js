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
    order: null,
    items: [],
    submittedAt: '',
    // 主人调整过你的点单时会有一条说明（去掉某道菜后会写上）
    hostNote: ''
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  async refresh(force) {
    this.setData({ loading: true });
    try {
      const session = await app.ensureSession(!!force);
      const cfg = session.config || null;
      const deadlineTs = cfg && cfg.deadlineTs ? Number(cfg.deadlineTs) : 0;

      this.setData({
        loading: false,
        inited: !!session.inited,
        isAdmin: !!session.isAdmin,
        cfg,
        deadlineText: deadlineTs ? fmt.fmtShort(deadlineTs) + '（' + fmt.countdown(deadlineTs) + '）' : '不限时间',
        closed: !!(deadlineTs && Date.now() > deadlineTs)
      });

      if (!session.inited) {
        this.setData({ order: null, items: [], submittedAt: '' });
        return;
      }

      const res = await api.call('myOrder');
      this.applyOrder(res.order || null);
    } catch (err) {
      this.setData({ loading: false });
      api.toastErr(err);
    }
  },

  applyOrder(order) {
    if (!order) {
      this.setData({ order: null, items: [], submittedAt: '', hostNote: '' });
      return;
    }
    const items = (order.items || []).map((i) => ({
      dishId: i.dishId,
      name: i.name,
      emoji: i.emoji || '🍽',
      qty: i.qty,
      note: i.note || ''
    }));
    let submittedAt = '';
    if (order.createdAt) {
      const t = new Date(order.createdAt).getTime();
      if (!isNaN(t)) submittedAt = fmt.fmtShort(t);
    }
    this.setData({ order, items, submittedAt, hostNote: order.hostNote || '' });
  },

  goIndex() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  async onCancel() {
    const ok = await api.confirm('撤销后你的点单会被删除，确定吗？');
    if (!ok) return;
    api.loading('撤销中');
    try {
      await api.call('cancelOrder');
      api.hideLoading();
      this.applyOrder(null);
      api.toast('已撤销', 'success');
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  },

  onCopy() {
    const order = this.data.order;
    if (!order) return;
    const lines = [];
    lines.push('【' + ((this.data.cfg && this.data.cfg.title) || '家宴') + '】' + order.nick + ' 的点单');
    lines.push('人数：' + order.partySize + (order.arriveAt ? '　到达：' + order.arriveAt : ''));
    (order.items || []).forEach((i) => {
      lines.push('· ' + i.name + ' ×' + i.qty + (i.note ? '（' + i.note + '）' : ''));
    });
    if (order.note) lines.push('备注：' + order.note);
    wx.setClipboardData({ data: lines.join('\n') });
  },

  goMenu() {
    wx.navigateTo({ url: '/pages/admin/menu/menu' });
  },

  goDashboard() {
    wx.navigateTo({ url: '/pages/admin/dashboard/dashboard' });
  },

  onCopyCode() {
    const code = this.data.cfg && this.data.cfg.hostCode;
    if (!code) return api.toast('没有口令信息');
    wx.setClipboardData({ data: code });
  },

  /** 未初始化 → 一键开通；已初始化 → 输入主人口令 */
  async onBecomeAdmin() {
    if (!this.data.inited) {
      const ok = await api.confirm('你确定是这次家宴的主人吗？开通后你会成为管理员。');
      if (!ok) return;
      api.loading('开通中');
      try {
        const session = await api.call('init', {});
        await app.refreshSession();
        api.hideLoading();
        this.refresh(true);

        const code = (session && session.config && session.config.hostCode) || '';
        wx.showModal({
          title: '开通成功',
          content:
            '主人口令：' + code + '\n\n记好它（配偶输这个口令也能成为主人，一起看汇总）。\n\n下一步：点下面的「家宴设置与菜库」→ 导入内置菜库 → 勾选今晚的菜。',
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
      return;
    }

    const code = await api.prompt('请输入主人口令（在主人口袋里）', '成为主人', '4 位数字');
    if (code === null || code === '') return;
    api.loading('验证中');
    try {
      await api.call('init', { hostCode: code });
      await app.refreshSession();
      api.hideLoading();
      api.toast('已获得主人权限', 'success');
      this.refresh(true);
    } catch (err) {
      api.hideLoading();
      api.toastErr(err);
    }
  }
});
