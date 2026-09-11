function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 2026-09-12 18:30 周六 */
function fmtFull(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ' 周' +
    WEEK[d.getDay()]
  );
}

/** 9月12日 18:30 */
function fmtShort(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 距截止时间的人话描述 */
function countdown(ts) {
  const diff = Number(ts) - Date.now();
  if (diff <= 0) return '已截止';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return '还剩 ' + mins + ' 分钟';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return '还剩 ' + hours + ' 小时';
  return '还剩 ' + Math.floor(hours / 24) + ' 天';
}

/** 把日期时间拆成 picker 需要的字符串 */
function toDateStr(ts) {
  const d = ts ? new Date(Number(ts)) : new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function toTimeStr(ts) {
  const d = ts ? new Date(Number(ts)) : new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** '2026-09-12' + '18:30' → 时间戳（本地时区） */
function joinDateTime(dateStr, timeStr) {
  const d = String(dateStr || '').split('-').map(Number);
  const t = String(timeStr || '').split(':').map(Number);
  if (d.length !== 3 || t.length !== 2) return 0;
  return new Date(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0).getTime();
}

/**
 * 保存截止时间时的取值：开关没打开就一律 0（不限时间）。
 *
 * 这条规则很重要——设置页的日期选择器在"当前没有截止时间"时会默认显示"明天此刻"，
 * 如果保存时无脑用选择器的值，主人只是想改个标题、点一下保存，就会被悄悄设上一个截止时间
 * （比如周四晚保存 → 周五晚截止 → 周六上午朋友就点不了了）。
 */
function deadlineForSave(enabled, dateStr, timeStr) {
  if (!enabled) return 0;
  return joinDateTime(dateStr, timeStr);
}

/** 这个截止时间是否已经过去了（保存前用来拦一下） */
function isPastDeadline(ts) {
  const t = Number(ts) || 0;
  return t > 0 && t <= Date.now();
}

/**
 * 解析「改份数」输入框里的内容。
 * 空/非数字 → null（表示别改）；负数按 0（0 = 去掉）；超过 99 按 99。
 * 单独抽出来是因为"解析用户手输的数字"是最容易出边界 bug 的地方。
 */
function parseQtyInput(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null;
  const n = Math.floor(Number(s));
  if (!isFinite(n)) return null;
  return Math.min(99, Math.max(0, n));
}

module.exports = {
  fmtFull,
  fmtShort,
  countdown,
  toDateStr,
  toTimeStr,
  joinDateTime,
  deadlineForSave,
  isPastDeadline,
  parseQtyInput,
  pad
};
