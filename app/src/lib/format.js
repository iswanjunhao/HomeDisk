/**
 * 格式化辅助：文件大小、时间
 */

/** 字节数转人类可读字符串 */
function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  const n = Number(bytes);
  if (Number.isNaN(n)) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 小于 10 保留一位小数，否则取整，读数更清爽
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
}

/** 时间戳转 "2026-10-26 21:38" */
function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间：刚刚 / 5 分钟前 / 3 天前 / 具体日期 */
function formatRelative(ms) {
  if (!ms) return '-';
  const diff = Date.now() - Number(ms);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 3600 * 1000) return Math.floor(diff / 86400000) + ' 天前';
  return formatTime(ms);
}

module.exports = { formatSize, formatTime, formatRelative };
