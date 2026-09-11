const config = require('../config.js');

/**
 * 把云开发的原始报错翻译成人能看懂、能照做的中文。
 * 部署期最常见的两类失败（云函数没部署 / envId 不对）原始报错长得一样难懂，
 * 这里直接告诉用户该点哪里。
 */
function mapError(errMsg) {
  const msg = String(errMsg || '');

  if (/FunctionName|Function not found|not found|-501000|-501001/i.test(msg)) {
    return '云函数 api 还没部署：请在微信开发者工具里右键 cloudfunctions/api →「上传并部署：云端安装依赖」';
  }
  if (/init first|isn't enabled|is not enabled|请先开通|cloud\.init|Cloud API/i.test(msg)) {
    return '云开发没有初始化成功：确认已开通云开发，并在 miniprogram/config.js 里填对 envId（见部署手册第 4 步）';
  }
  if (/-6010|env.*(invalid|not exist)|envId|环境/i.test(msg)) {
    return '云环境 ID 不对或不存在：请在 miniprogram/config.js 里填上正确的 envId（见部署手册第 4 步）';
  }
  if (/timeout|timed out|-504003/i.test(msg)) {
    return '请求超时：检查网络后重试；若是「导入菜库」超时，请把云函数超时时间改成 20 秒';
  }
  if (/network|ERR_|request:fail/i.test(msg)) {
    return '网络异常，请检查网络后重试';
  }
  return msg || '未知错误，请重试';
}

/**
 * 统一调用云函数 api
 * resolve 时返回 result.data，reject 时抛出带中文 message 的 Error
 */
function call(action, data) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || !wx.cloud.callFunction) {
      reject(new Error('当前环境不支持云开发：请把调试基础库调到 2.2.3 以上'));
      return;
    }
    wx.cloud.callFunction({
      name: config.cloudFunctionName,
      data: Object.assign({ action: action }, data || {}),
      success(res) {
        const r = (res && res.result) || {};
        if (r.ok) {
          resolve(r.data);
        } else {
          reject(new Error(r.msg || '操作失败'));
        }
      },
      fail(err) {
        reject(new Error(mapError(err && err.errMsg)));
      }
    });
  });
}

function toast(title, icon) {
  wx.showToast({ title: title, icon: icon || 'none', duration: 1800 });
}

function toastErr(err) {
  wx.showToast({ title: (err && err.message) || '出错了', icon: 'none', duration: 2500 });
}

function confirm(content, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '确认',
      content: content,
      success(res) {
        resolve(!!res.confirm);
      },
      fail() {
        resolve(false);
      }
    });
  });
}

function prompt(content, title, placeholder) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '请输入',
      content: content,
      editable: true,
      placeholderText: placeholder || '',
      success(res) {
        resolve(res.confirm ? String(res.content || '').trim() : null);
      },
      fail() {
        resolve(null);
      }
    });
  });
}

function loading(title) {
  wx.showLoading({ title: title || '加载中', mask: true });
}

function hideLoading() {
  wx.hideLoading();
}

module.exports = { call, mapError, toast, toastErr, confirm, prompt, loading, hideLoading };
