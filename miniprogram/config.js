/**
 * 家宴点菜 · 前端配置
 *
 * envId：云开发环境 ID。
 *   - 只有一个云环境时，留空字符串即可（使用默认环境）。
 *   - 有多个环境时，必须填，例如 'family-dinner-8gxxxxx'。
 *   环境 ID 在微信开发者工具 → 云开发 → 左上角环境名旁边可以看到。
 */
module.exports = {
  envId: '',
  // 云函数名（保持默认即可，除非你重命名了云函数目录）
  cloudFunctionName: 'api',
  // 微信小程序基础库要求
  minLibVersion: '2.2.3'
};
