/**
 * 磁盘 / 卷检测
 * ------------------------------------------------------------------
 * 目标：在家庭局域网云盘中识别「除了系统盘以外、已挂载的其他磁盘」
 *      （机械硬盘、外接 U 盘、NAS / NFS / SMB 挂载点等），并允许用户在
 *      共享设置里把它们作为可共享的存储位置添加进来。
 *
 * 设计：
 *  - 优先解析 /proc/mounts（Linux 必有；macOS 用 `mount` 命令；Windows 用盘符枚举），
 *    不依赖 lsblk 是否可用 —— 旧逻辑只靠 lsblk，一旦 lsblk 不可用候选列表就为空。
 *  - 再用 lsblk（若可用）补充卷标(label)与容量(size)，让候选列表更友好。
 *  - 过滤掉伪文件系统(tmpfs/proc/sysfs…)、系统关键挂载点(/boot /efi 等)以及
 *    系统盘根本身，避免误把整个系统盘暴露。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { formatSize } = require('./format');

// 伪文件系统（不算作可共享磁盘）
const PSEUDO_FS = new Set([
  'proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'mqueue',
  'overlay', 'squashfs', 'securityfs', 'pstore', 'bpf', 'tracefs', 'debugfs',
  'hugetlbfs', 'ramfs', 'autofs', 'binfmt_misc', 'configfs', 'fusectl',
  'rpc_pipefs', 'nsfs', 'efivarfs', 'fuse.portal', 'fuse.gvfsd-fuse', 'zfs',
]);

// 这些挂载点即使真实也绝不自动建议共享（系统关键）
const SYSTEM_MOUNTS = new Set([
  '/proc', '/sys', '/dev', '/run', '/tmp', '/boot', '/boot/efi', '/efi', '/var/lib/docker',
]);

// 数据文件系统（用于判断「未挂载设备」是否值得提示需要先挂载）
const DATA_FS = new Set([
  'ntfs', 'exfat', 'vfat', 'fat', 'fat32', 'ext2', 'ext3', 'ext4',
  'xfs', 'btrfs', 'f2fs', 'apfs', 'hfs', 'hfsplus', 'reiserfs', 'jfs',
]);

/** /proc/mounts 里用八进制转义特殊字符（空格 \040、制表 \011、换行 \012、反斜杠 \134） */
function unescapeProc(s) {
  return String(s || '')
    .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 把设备名归并到「物理磁盘」级别：/dev/sda2 -> sda，/dev/nvme0n1p3 -> nvme0n1，/dev/mmcblk0p1 -> mmcblk0 */
function deviceBase(dev) {
  let s = String(dev || '').replace(/^\/dev\//, '');
  s = s.replace(/^(nvme\d+n\d+)p\d+$/, '$1');
  s = s.replace(/^(\w+\d+)p\d+$/, '$1');
  s = s.replace(/^([a-z]+)\d+$/, '$1');
  return s;
}

/** 枚举所有挂载点（最小信息：device / mountpoint / fstype） */
async function enumerateMounts() {
  const platform = process.platform;
  if (platform === 'win32') {
    const list = [];
    for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = L + ':\\';
      try { fs.accessSync(p); list.push({ device: p, mountpoint: p, fstype: 'ntfs' }); } catch (e) { /* 无此盘符 */ }
    }
    return list;
  }

  // Linux：解析 /proc/mounts（最可靠，不需要 lsblk）
  let txt = null;
  for (const f of ['/proc/mounts', '/proc/self/mounts']) {
    try { txt = fs.readFileSync(f, 'utf8'); break; } catch (e) { /* 试下一个 */ }
  }
  if (txt) {
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      const p = line.split(' ');
      if (p.length < 3) continue;
      out.push({ device: unescapeProc(p[0]), mountpoint: unescapeProc(p[1]), fstype: p[2] });
    }
    return out;
  }

  // macOS：用 mount 命令兜底
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileP('mount', [], { timeout: 5000 });
      const out = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(.+?)\s+on\s+(.+?)\s+\(([^,]+)/);
        if (m) out.push({ device: m[1].trim(), mountpoint: m[2].trim(), fstype: m[3].trim() });
      }
      return out;
    } catch (e) { return []; }
  }
  return [];
}

/** 用 lsblk 补充卷标 / 容量（若可用）；返回 { byMp: {挂载点:行}, devices: [未挂载但带文件系统的块设备] } */
async function readLsblk() {
  try {
    const { stdout } = await execFileP(
      'lsblk', ['-J', '-b', '-o', 'NAME,FSTYPE,SIZE,MOUNTPOINT,LABEL,UUID'],
      { timeout: 8000 }
    );
    const obj = JSON.parse(stdout);
    const rows = [];
    const walk = (n) => {
      if (!n) return;
      if (n.name || n.mountpoint) rows.push(n);
      (n.children || []).forEach(walk);
    };
    (obj.blockdevices || []).forEach(walk);
    const byMp = {};
    const devices = [];
    for (const r of rows) {
      if (r.mountpoint) byMp[r.mountpoint] = r;
      else if (r.name && r.fstype) devices.push(r);   // 未挂载、但带文件系统的块设备
    }
    return { byMp, devices };
  } catch (e) {
    return { byMp: {}, devices: [] };
  }
}

function statfsTotal(mp) {
  try {
    const st = fs.statfsSync(mp);
    return st.blocks * st.bsize;
  } catch (e) { return 0; }
}

/** 判断一个挂载点是否值得作为候选（真实数据卷，且非系统关键、非系统盘根） */
function isShareableMount(mp) {
  if (!mp || mp === '/') return false;
  if (mp.startsWith('/proc') || mp.startsWith('/sys') || mp.startsWith('/dev') || mp.startsWith('/run')) return false;
  if (SYSTEM_MOUNTS.has(mp)) return false;
  return true;
}

/**
 * 检测可作为共享位置的卷（富信息版本，供 /api/shares/candidates 使用）
 * @param {{configured?:Set<string>, hasMarker?:(p:string)=>boolean}} opts
 */
async function detectVolumes(opts = {}) {
  const configured = opts.configured || new Set();
  const hasMarker = opts.hasMarker;
  const volumes = [];
  const mounts = await enumerateMounts();
  const rootMount = mounts.find((m) => m.mountpoint === '/');
  const rootDev = rootMount ? rootMount.device : null;
  const lsblk = await readLsblk();
  const seen = new Set();

  for (const m of mounts) {
    const mp = m.mountpoint;
    if (!mp) continue;
    if (PSEUDO_FS.has(m.fstype)) continue;
    if (!isShareableMount(mp)) continue;
    if (configured.has(mp)) continue;
    if (seen.has(mp)) continue;          // 同一挂载点可能出现多次（绑定挂载等）
    seen.add(mp);

    const en = lsblk.byMp[mp] || {};
    const size = Number(en.size) || statfsTotal(mp);
    const label = (en.label || '').trim() || path.basename(mp) || m.device;
    const baseDev = deviceBase(m.device);
    const baseRoot = rootDev ? deviceBase(rootDev) : null;
    const sameDisk = !!(baseRoot && baseDev && baseDev === baseRoot);
    volumes.push({
      type: 'mounted',
      path: mp,
      label,
      device: m.device,
      fstype: m.fstype,
      sizeText: formatSize(size || 0),
      hasMarker: hasMarker ? !!hasMarker(mp) : false,
      kind: sameDisk ? 'system' : 'external',
      kindText: sameDisk ? '系统盘上的分区' : '独立 / 外接磁盘',
    });
  }

  // 未挂载但带文件系统的块设备（提示需要先挂载）
  for (const r of lsblk.devices) {
    const fs0 = String(r.fstype || '').toLowerCase();
    if (DATA_FS.has(fs0) && !configured.has('/dev/' + r.name)) {
      volumes.push({
        type: 'device',
        device: '/dev/' + r.name,
        label: (r.label || '').trim() || ('未挂载的磁盘 ' + r.name),
        fstype: r.fstype,
        sizeText: formatSize(Number(r.size) || 0),
        note: '该设备尚未挂载，请先在系统中挂载后再添加',
        kind: 'device',
      });
    }
  }

  // 排序：常见数据挂载位置(mnt/media/run-media/Volumes)优先，其余按路径
  const rank = (v) => (/^\/(mnt|media|run\/media|Volumes)/.test(v.path || '') ? 0 : 1);
  volumes.sort((a, b) => (rank(a) - rank(b)) || (a.path || '').localeCompare(b.path || ''));
  return volumes;
}

/**
 * 浏览器根目录快速跳转用的卷列表（精简版：系统盘根 + 已挂载的真实数据卷）
 */
async function quickVolumes() {
  const mounts = await enumerateMounts();
  const out = [];

  // Windows：每个盘符都是入口，C 盘标注为系统盘
  if (process.platform === 'win32') {
    for (const m of mounts) {
      const isSystem = /^c:/i.test(m.mountpoint);
      out.push({
        name: (isSystem ? '系统盘 ' : '') + m.mountpoint,
        path: m.mountpoint,
        kind: isSystem ? 'system' : 'volume',
        device: m.device,
        fstype: m.fstype,
      });
    }
    return out;
  }

  // 系统盘根（用户可手动选择共享整块系统盘，谨慎）
  out.push({ name: '系统盘（/）', path: '/', kind: 'system' });
  const seen = new Set(['/']);
  for (const m of mounts) {
    if (PSEUDO_FS.has(m.fstype)) continue;
    if (!isShareableMount(m.mountpoint)) continue;
    if (seen.has(m.mountpoint)) continue;
    seen.add(m.mountpoint);
    const label = path.basename(m.mountpoint) || m.mountpoint;
    out.push({
      name: label,
      path: m.mountpoint,
      kind: 'volume',
      device: m.device,
      fstype: m.fstype,
    });
  }
  return out;
}

module.exports = { enumerateMounts, detectVolumes, quickVolumes, isShareableMount, deviceBase };
