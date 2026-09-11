const config = require('./config.js');
const api = require('./utils/api.js');

App({
  globalData: {
    openid: '',
    isAdmin: false,
    inited: false,
    cfg: null
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '版本太低',
        content: '请把微信更新到较新版本，或在开发者工具里把调试基础库调到 2.2.3 以上。',
        showCancel: false
      });
      return;
    }
    const opts = { traceUser: true };
    if (config.envId) opts.env = config.envId;
    wx.cloud.init(opts);
  },

  /**
   * 全局只请求一次 whoami，多个页面共用结果。
   * force = true 时强制刷新。
   */
  ensureSession(force) {
    if (this._sessionPromise && !force) return this._sessionPromise;

    this._sessionPromise = api
      .call('whoami')
      .then((res) => {
        this.globalData.openid = res.openid || '';
        this.globalData.isAdmin = !!res.isAdmin;
        this.globalData.inited = !!res.inited;
        this.globalData.cfg = res.config || null;
        return res;
      })
      .catch((err) => {
        this._sessionPromise = null;
        throw err;
      });

    return this._sessionPromise;
  },

  /** 有写操作后同步一次身份/配置 */
  refreshSession() {
    return this.ensureSession(true);
  }
});
