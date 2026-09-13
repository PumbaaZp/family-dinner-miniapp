#!/usr/bin/env node
/**
 * 迭代耗时统计
 *
 * 为什么要这个：主人要"每次版本迭代花了多久"，好做后面的统计分析。
 *
 * 数据来源只有 git 的提交时间戳 —— 我没法知道你什么时候真的在敲代码，
 * 所以口径必须写明白，不然统计出来的数字会骗人：
 *
 *   - **相邻提交间隔 ≤ ITER_GAP_MIN（默认 30 分钟）→ 算同一次迭代**：
 *     一次迭代通常是"改代码 → 跑测试 → 提交 → 补日志 → 再提交"这样连着几下。
 *   - **间隔更大 → 算跨段（新的一次迭代）**：多半是去吃饭/睡觉/忙别的了。
 *   - 一次迭代的耗时 = 末次提交时刻 − 首次提交时刻。单提交的迭代记为 0（显示成 <1 分钟）。
 *   - 想写**实际耗时**：在 `tools/worklog-manual.json` 里按提交短哈希给分钟数
 *     （`{ "8f22393": 35 }`），它会**优先于**估算值；给整个迭代也可以（写在迭代首次提交上）。
 *
 * 输出：
 *   - `工作日志-耗时统计.md`（人看的表：总览 / 按天 / 按迭代明细）
 *   - `--json`：把同样的数据打到 stdout，给别的脚本或 Excel 用
 *   - `--check`：只算不写文件（CI / 测试用）
 *
 * 用法：
 *   node tools/worklog-stats.js            # 刷新统计文件
 *   node tools/worklog-stats.js --json     # 输出 JSON
 *   node tools/worklog-stats.js --check    # 只跑逻辑（不写文件）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, '工作日志-耗时统计.md');
const MANUAL_FILE = path.join(ROOT, 'tools', 'worklog-manual.json');

/** 相邻提交间隔超过这个分钟数，就当"另一次的迭代" */
const ITER_GAP_MIN = 30;
/** 一次迭代的标题 / 一句话描述从哪几个提交里取（取首个非 docs: 的提交更贴切） */
const DESC_MAX = 60;

/* ------------------------------ 纯函数（可测） ------------------------------ */

/**
 * 解析 `git log --pretty=format:%h|%ad|%s --date=format:%Y-%m-%d %H:%M` 的输出
 * 返回按时间升序的 [{ hash, at(Date), atText, subject }]
 */
function parseGitLog(stdout) {
  const rows = [];
  String(stdout || '')
    .split('\n')
    .forEach((line) => {
      const s = line.trim();
      if (!s) return;
      const a = s.indexOf('|');
      const b = s.indexOf('|', a + 1);
      if (a < 0 || b < 0) return;
      const hash = s.slice(0, a).trim();
      const atText = s.slice(a + 1, b).trim();
      const subject = s.slice(b + 1).trim();
      const at = new Date(atText.replace(' ', 'T') + ':00');
      if (!hash || isNaN(at.getTime())) return;
      rows.push({ hash, at, atText, subject });
    });
  rows.sort((x, y) => x.at - y.at);
  return rows;
}

/** 分钟差（b - a），四舍五入 */
function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 分钟 → 「1 小时 20 分」这种好读的写法 */
function humanMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 1) return '<1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? h + ' 小时 ' + rest + ' 分' : h + ' 小时';
}

/**
 * 提交 → 迭代分组
 * 间隔 ≤ gapMin 归入同一次迭代；否则新起一次。
 * 返回 [{ start, end, commits:[...], day }]（按时间升序）
 */
function groupIterations(commits, gapMin) {
  const gap = Number(gapMin) || ITER_GAP_MIN;
  const list = (commits || []).slice().sort((a, b) => a.at - b.at);
  const out = [];
  let cur = null;
  list.forEach((c) => {
    if (cur && minutesBetween(cur.end, c.at) <= gap) {
      cur.commits.push(c);
      cur.end = c.at;
      return;
    }
    cur = { start: c.at, end: c.at, commits: [c] };
    out.push(cur);
  });
  out.forEach((it) => {
    it.day = it.start.getFullYear() + '-' + pad2(it.start.getMonth() + 1) + '-' + pad2(it.start.getDate());
    it.span = minutesBetween(it.start, it.end);
    // 一句话：优先用"非 docs:"的第一个提交标题（docs 往往只是补日志）
    const main = it.commits.filter((c) => !/^docs:/.test(c.subject))[0] || it.commits[0];
    it.title = main.subject.length > DESC_MAX ? main.subject.slice(0, DESC_MAX) + '…' : main.subject;
    it.manual = null;
  });
  return out;
}

/**
 * 手工校正：{ 短哈希: 分钟 } → 标在对应迭代上（整个迭代按这个数算）
 * 一个迭代里只要有一个提交被指定，就用它（`manual` 字段），优先于估算的 span。
 */
function applyManual(iterations, manual) {
  const map = manual || {};
  (iterations || []).forEach((it) => {
    let hit = null;
    it.commits.forEach((c) => {
      const v = Number(map[c.hash]);
      if (hit === null && isFinite(v) && v >= 0) hit = v;
    });
    it.manual = hit;
    it.minutes = hit === null ? it.span : hit;
    it.estimated = hit === null;
  });
  return iterations;
}

/** 按天汇总 + 总览 */
function summarize(iterations) {
  const byDay = {};
  const order = [];
  (iterations || []).forEach((it) => {
    if (!byDay[it.day]) {
      byDay[it.day] = { day: it.day, iters: 0, commits: 0, minutes: 0, first: it.start, last: it.end };
      order.push(it.day);
    }
    const d = byDay[it.day];
    d.iters += 1;
    d.commits += it.commits.length;
    d.minutes += it.minutes;
    if (it.start < d.first) d.first = it.start;
    if (it.end > d.last) d.last = it.end;
  });
  const days = order.sort().map((k) => {
    const d = byDay[k];
    d.span = minutesBetween(d.first, d.last);
    return d;
  });
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);
  return {
    iterations: (iterations || []).length,
    commits: (iterations || []).reduce((s, it) => s + it.commits.length, 0),
    days: days,
    totalMinutes: totalMinutes,
    avgMinutes: iterations && iterations.length ? Math.round(totalMinutes / iterations.length) : 0,
    maxMinutes: (iterations || []).reduce((m, it) => Math.max(m, it.minutes), 0)
  };
}

/** 每个提交"距上次提交多久"（最细的一档，方便自己按别的阈值分组） */
function perCommit(commits, gapMin) {
  const gap = Number(gapMin) || ITER_GAP_MIN;
  const list = (commits || []).slice().sort((a, b) => a.at - b.at);
  return list.map((c, i) => {
    const prev = i > 0 ? list[i - 1] : null;
    const minutes = prev ? minutesBetween(prev.at, c.at) : null;
    return {
      hash: c.hash,
      at: c.at,
      atText: c.atText,
      subject: c.subject,
      day: c.at.getFullYear() + '-' + pad2(c.at.getMonth() + 1) + '-' + pad2(c.at.getDate()),
      minutes: minutes,
      // 跨段：距上次提交超过阈值，说明中间大概率去忙别的了（数字不该算成"干活时间"）
      acrossGap: minutes !== null && minutes > gap
    };
  });
}

/** 生成 Markdown（统计文件的内容） */
function renderMarkdown(iterations, stats, meta) {
  const lines = [];
  lines.push('# 工作日志 · 迭代耗时统计');
  lines.push('');
  lines.push('> 这个文件是**自动生成**的：`node tools/worklog-stats.js`。别手改，改完下次就被覆盖了。');
  lines.push('> 想写"实际耗时"，编辑 `tools/worklog-manual.json`（`{ "' + (iterations[0] ? iterations[0].commits[0].hash : 'abc1234') + '": 35 }`），它优先于估算值。');
  lines.push('>');
  lines.push('> 统计到这个提交为止：`' + ((meta.perCommit && meta.perCommit.length) ? meta.perCommit[meta.perCommit.length - 1].hash : '—') + '`（' + (meta.lastAt || '—') + '）。');
  lines.push('> **你正在做的这一次提交不在内** —— 数字永远比工作区慢一拍，下次跑就补上了，别当成算错。');
  lines.push('');
  lines.push('**口径**（很重要，不写清楚数字会骗人）：');
  lines.push('');
  lines.push('- 数据源是 **git 提交时间戳** —— 代码里没有"我开始动手了"这种事件，只能靠提交间隔推算。');
  lines.push('- 相邻提交间隔 **≤ ' + (meta.gapMin || ITER_GAP_MIN) + ' 分钟** 算**同一次迭代**（改代码 → 跑测试 → 提交 → 补日志，通常是连着几下）。');
  lines.push('- 间隔更大就**另起一次迭代**：多半是去吃饭/睡觉/忙别的了，硬算进去会虚高。');
  lines.push('- 一次迭代的耗时 = **末次提交时刻 − 首次提交时刻**。只提交了一次的迭代记 0，显示成 `<1 分钟`。');
  lines.push('- 标 ⚠️ 的行是**手工校正过**的（`tools/worklog-manual.json`）。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push('| 统计范围 | ' + (meta.firstAt || '—') + ' ~ ' + (meta.lastAt || '—') + ' |');
  lines.push('| 迭代次数 | ' + stats.iterations + ' |');
  lines.push('| 提交数 | ' + stats.commits + ' |');
  lines.push('| 累计耗时（估算） | ' + humanMinutes(stats.totalMinutes) + '（' + stats.totalMinutes + ' 分钟） |');
  lines.push('| 平均每次迭代 | ' + humanMinutes(stats.avgMinutes) + ' |');
  lines.push('| 最长一次迭代 | ' + humanMinutes(stats.maxMinutes) + ' |');
  lines.push('| 有产出的天数 | ' + stats.days.length + ' 天 |');
  lines.push('');
  lines.push('## 按天');
  lines.push('');
  lines.push('| 日期 | 迭代 | 提交 | 当日耗时 | 时间跨度（首次~末次提交） |');
  lines.push('|---|---|---|---|---|');
  stats.days.forEach((d) => {
    lines.push(
      '| ' + d.day + ' | ' + d.iters + ' | ' + d.commits + ' | ' + humanMinutes(d.minutes) + ' | ' +
        pad2(d.first.getHours()) + ':' + pad2(d.first.getMinutes()) + ' ~ ' +
        pad2(d.last.getHours()) + ':' + pad2(d.last.getMinutes()) + ' |'
    );
  });
  if (!stats.days.length) lines.push('| — | 0 | 0 | — | — |');
  lines.push('');
  lines.push('## 按迭代明细');
  lines.push('');
  lines.push('| # | 日期 | 起止 | 耗时 | 提交 | 这次做了什么 |');
  lines.push('|---|---|---|---|---|---|');
  iterations.forEach((it, i) => {
    const hhmm = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const same = it.commits.length === 1 ? hhmm(it.start) : hhmm(it.start) + ' ~ ' + hhmm(it.end);
    lines.push(
      '| ' + (i + 1) + ' | ' + it.day.slice(5) + ' | ' + same + ' | ' +
        (it.estimated ? '' : '⚠️ ') + humanMinutes(it.minutes) + ' | ' + it.commits.length + ' | ' +
        it.title.replace(/\|/g, '/') + ' |'
    );
  });
  if (!iterations.length) lines.push('| — | — | — | — | — | — |');
  lines.push('');
  lines.push('## 按提交明细（最细的一档）');
  lines.push('');
  lines.push('「距上次」= 距上一个提交多久。标 🕳 的是**跨段**（超过 ' + (meta.gapMin || ITER_GAP_MIN) + ' 分钟，中间多半去忙别的了，别当成干活时间）。');
  lines.push('');
  lines.push('| # | 日期 | 时刻 | 距上次 | 提交 | 标题 |');
  lines.push('|---|---|---|---|---|---|');
  (meta.perCommit || []).forEach((c, i) => {
    const hhmm = pad2(c.at.getHours()) + ':' + pad2(c.at.getMinutes());
    const gapText = c.minutes === null ? '—' : (c.acrossGap ? '🕳 ' : '') + humanMinutes(c.minutes);
    lines.push('| ' + (i + 1) + ' | ' + c.day.slice(5) + ' | ' + hhmm + ' | ' + gapText + ' | `' + c.hash + '` | ' + c.subject.replace(/\|/g, '/') + ' |');
  });
  if (!(meta.perCommit || []).length) lines.push('| — | — | — | — | — | — |');
  lines.push('');
  lines.push('## 怎么用它做统计');
  lines.push('');
  lines.push('- 想看趋势：把「按天」那张表贴进表格软件，`当日耗时` 列做折线图。');
  lines.push('- 想按自己的粒度算：用「按提交明细」那列的"距上次"，想按 10 分钟还是 2 小时切段都行。');
  lines.push('- 要更细的数据：`node tools/worklog-stats.js --json` 输出 JSON（迭代 + 每次提交的分钟数、是否跨段、是否估算）。');
  lines.push('- 想让数字更准：每次收工前在 `tools/worklog-manual.json` 里写这一次迭代的实际分钟数（写在这次迭代的**首个提交**上即可）。');
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------ 跑 git + 输出 ------------------------------ */

/**
 * 跑 git log 并拿到输出。
 *
 * 两个坑都在这儿绕开了：
 *   1. `-c safe.directory=*`：Windows 上仓库属主和当前用户不一致时 git 会直接拒绝
 *      （"dubious ownership"），这是开发机的常见情况，不该让统计脚本挂在这种地方。
 *   2. **不用管道接输出**：某些受限环境不允许子进程开命名管道
 *      （`execFileSync` 会直接 EPERM）。这里把子进程的 stdout/stderr 重定向到临时文件，
 *      全程只有文件读写，到哪都能跑；顺带也不受 maxBuffer 限制。
 */
function readGitLog() {
  const tmpOut = path.join(os.tmpdir(), 'dsh-worklog-' + process.pid + '.out');
  const tmpErr = path.join(os.tmpdir(), 'dsh-worklog-' + process.pid + '.err');
  const fdOut = fs.openSync(tmpOut, 'w');
  const fdErr = fs.openSync(tmpErr, 'w');
  let res;
  try {
    res = spawnSync(
      'git',
      ['-c', 'safe.directory=*', 'log', '--no-merges', '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%h|%ad|%s'],
      { cwd: ROOT, stdio: ['ignore', fdOut, fdErr] }
    );
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  const out = fs.readFileSync(tmpOut, 'utf8');
  const err = fs.readFileSync(tmpErr, 'utf8');
  fs.unlinkSync(tmpOut);
  fs.unlinkSync(tmpErr);
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) throw new Error((err || '').trim().split('\n')[0] || 'git log 退出码 ' + res.status);
  return out;
}

function readManual() {
  if (!fs.existsSync(MANUAL_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
    const out = {};
    Object.keys(raw).forEach((k) => {
      if (k.startsWith('_')) return; // _readme 之类的说明字段
      const v = Number(raw[k]);
      if (isFinite(v) && v >= 0) out[k] = v;
    });
    return out;
  } catch (e) {
    console.warn('⚠️ tools/worklog-manual.json 不是合法 JSON，已忽略：' + e.message);
    return {};
  }
}

function build(commits, gapMin, manual) {
  const iterations = applyManual(groupIterations(commits, gapMin), manual);
  const stats = summarize(iterations);
  const meta = {
    gapMin: Number(gapMin) || ITER_GAP_MIN,
    firstAt: commits.length ? commits[0].atText : '',
    lastAt: commits.length ? commits[commits.length - 1].atText : '',
    perCommit: perCommit(commits, gapMin)
  };
  return { iterations, stats, meta };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.indexOf('--json') >= 0;
  const checkOnly = argv.indexOf('--check') >= 0;

  let commits;
  try {
    commits = parseGitLog(readGitLog());
  } catch (e) {
    console.error('读 git log 失败：' + (e && e.message));
    if (checkOnly) return 0;
    process.exit(1);
  }
  if (!commits.length) {
    console.error('git log 里没有提交，没什么可统计的');
    process.exit(1);
  }

  const { iterations, stats, meta } = build(commits, ITER_GAP_MIN, readManual());

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          gapMinutes: meta.gapMin,
          range: { from: meta.firstAt, to: meta.lastAt },
          totals: {
            iterations: stats.iterations,
            commits: stats.commits,
            minutes: stats.totalMinutes,
            avgMinutesPerIteration: stats.avgMinutes,
            maxMinutes: stats.maxMinutes,
            days: stats.days.length
          },
          days: stats.days.map((d) => ({
            day: d.day,
            iterations: d.iters,
            commits: d.commits,
            minutes: d.minutes,
            spanMinutes: d.span,
            first: d.first.toISOString(),
            last: d.last.toISOString()
          })),
          iterations: iterations.map((it, i) => ({
            index: i + 1,
            day: it.day,
            start: it.start.toISOString(),
            end: it.end.toISOString(),
            minutes: it.minutes,
            estimated: !!it.estimated,
            commits: it.commits.map((c) => ({ hash: c.hash, at: c.at.toISOString(), subject: c.subject })),
            title: it.title
          })),
          commits: (meta.perCommit || []).map((c) => ({
            hash: c.hash,
            day: c.day,
            at: c.at.toISOString(),
            minutesSincePrevious: c.minutes,
            acrossGap: !!c.acrossGap,
            subject: c.subject
          }))
        },
        null,
        2
      ) + '\n'
    );
    return 0;
  }

  const md = renderMarkdown(iterations, stats, meta);
  if (!checkOnly) {
    fs.writeFileSync(OUT_FILE, md, 'utf8');
    console.log('✅ 已刷新 ' + path.basename(OUT_FILE));
  }
  console.log(
    '   迭代 ' + stats.iterations + ' 次 / 提交 ' + stats.commits + ' 个 / 累计耗时 ' +
      humanMinutes(stats.totalMinutes) + '（平均 ' + humanMinutes(stats.avgMinutes) + '，最长 ' +
      humanMinutes(stats.maxMinutes) + '）'
  );
  stats.days.forEach((d) => {
    console.log('   · ' + d.day + '：' + d.iters + ' 次迭代 / ' + humanMinutes(d.minutes));
  });
  return 0;
}

module.exports = {
  parseGitLog,
  groupIterations,
  applyManual,
  summarize,
  perCommit,
  renderMarkdown,
  humanMinutes,
  minutesBetween,
  build,
  ITER_GAP_MIN,
  OUT_FILE,
  MANUAL_FILE
};

if (require.main === module) process.exit(main());
