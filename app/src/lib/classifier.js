/**
 * 文件分类：按扩展名把文件归入六大类，用于顶部筛选
 */

const path = require('path');

const CATEGORIES = {
  image: {
    label: '图片',
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'ico', 'tif', 'tiff'],
  },
  video: {
    label: '视频',
    exts: ['mp4', 'mkv', 'avi', 'mov', 'rmvb', 'rm', 'flv', 'webm', 'm2ts', 'ts', 'm4v', 'mpg', 'mpeg', '3gp', 'wmv'],
  },
  audio: {
    label: '音频',
    exts: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'ape', 'wma', 'opus', 'aiff'],
  },
  doc: {
    label: '文档',
    exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub', 'mobi', 'rtf', 'odt', 'ods', 'odp', 'json', 'log'],
  },
  archive: {
    label: '压缩包',
    exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'lz', 'lzma'],
  },
};

// 反查表：扩展名 -> 分类 key
const EXT_MAP = (() => {
  const m = {};
  for (const [key, def] of Object.entries(CATEGORIES)) {
    for (const ext of def.exts) m[ext] = key;
  }
  return m;
})();

/** 根据文件名判断分类，返回 image/video/audio/doc/archive/other */
function classify(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_MAP[ext] || 'other';
}

/** 供前端渲染分类导航 */
function listCategories() {
  return [
    { key: 'all', label: '全部' },
    ...Object.entries(CATEGORIES).map(([key, def]) => ({ key, label: def.label })),
    { key: 'other', label: '其他' },
  ];
}

module.exports = { classify, listCategories, CATEGORIES };
