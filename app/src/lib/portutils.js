/**
 * 端口占用检测与「自家服务」识别
 *
 * 需求约定：
 *  - 用户选的端口被占时，先判断占用进程是不是本家庭云盘服务；
 *  - 是 → 自动结束它（重启 / 换配置场景下这是期望行为）；
 *  - 不是 → 不动它，返回占用信息，由上层提示用户更换端口号。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

/** 本服务入口文件的绝对路径（用于识别"是不是我们自己"） */
const SERVER_FILE = (() => {
  try {
    return fs.realpathSync(path.join(__dirname, '..', '..', 'server.js'));
  } catch (e) {
    return 'server.js';
  }
})();

/** 尝试绑定端口判断是否空闲 */
function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(Number(port), host);
  });
}

/** 读取 /proc/<pid>/cmdline（Linux） */
function readCmdline(pid) {
  try {
    const raw = fs.readFileSync(path.join('/proc', String(pid), 'cmdline'), 'utf8');
    return raw.replace(/\0/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

/** 找出正在监听该端口的进程（Linux 用 ss，Windows 用 netstat） */
async function findPortPids(port) {
  const out = [];
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('netstat', ['-ano', '-p', 'tcp'], { timeout: 8000 });
      for (const line of stdout.split('\n')) {
        const cols = line.trim().split(/\s+/);
        // TCP  0.0.0.0:8080  0.0.0.0:0  LISTENING  1234
        if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(':' + port)) {
          out.push({ pid: Number(cols[4]), cmd: '' });
        }
      }
    } else {
      const { stdout } = await execFileP('ss', ['-ltnp'], { timeout: 8000 });
      for (const line of stdout.split('\n')) {
        if (!line.includes(':' + port + ' ')) continue;
        const m = /pid=(\d+)/.exec(line);
        if (m) {
          const pid = Number(m[1]);
          out.push({ pid, cmd: readCmdline(pid) });
        }
      }
    }
  } catch (e) { /* ss/netstat 不可用则返回空，上层按"未知占用"处理 */ }

  // 去重
  const seen = new Set();
  return out.filter((x) => (seen.has(x.pid) ? false : (seen.add(x.pid), true)));
}

/** 判断某 pid 是否为本家庭云盘服务 */
function isOurProcess(pid) {
  if (process.platform === 'win32') {
    // Windows：用 wmic 查命令行（尽力而为）
    return execFileP('wmic', ['process', 'where', 'processid=' + pid, 'get', 'commandline'], { timeout: 8000 })
      .then(({ stdout }) => /server\.js/i.test(stdout) && /homecloud/i.test(stdout))
      .catch(() => false);
  }
  try {
    const cmd = readCmdline(pid);
    if (!cmd) return false;
    if (cmd.includes(SERVER_FILE)) return true;
    // 兜底：命令行里同时出现 homecloud 与 server.js（项目目录被移动过的情况）
    return /homecloud/i.test(cmd) && /server\.js/.test(cmd);
  } catch (e) {
    return false;
  }
}

/** 结束进程：先 SIGTERM，2 秒后仍存活再 SIGKILL */
async function killPid(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return; }
  await new Promise((r) => setTimeout(r, 2000));
  try {
    process.kill(pid, 0); // 还活着
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 已退出 */ }
  } catch (e) { /* 已退出 */ }
}

/**
 * 端口冲突处理总入口
 * 返回 { free, ours, killed, pids }
 *  - free  ：最终端口是否可用
 *  - ours  ：占用者里是否包含本服务
 *  - killed：被自动结束的本服务 PID 列表
 *  - pids  ：[{ pid, cmd, ours }] 占用进程明细
 */
async function resolvePortConflict(port, opts = {}) {
  const autoKillOurs = opts.autoKillOurs !== false;
  let free = await isPortFree(port);
  if (free) return { free: true, ours: false, killed: [], pids: [] };

  const found = await findPortPids(port);
  const marked = [];
  for (const p of found) {
    marked.push({ pid: p.pid, cmd: p.cmd, ours: await isOurProcess(p.pid) });
  }

  const killed = [];
  if (autoKillOurs) {
    for (const p of marked) {
      if (p.ours) {
        await killPid(p.pid);
        killed.push(p.pid);
      }
    }
    if (killed.length) {
      await new Promise((r) => setTimeout(r, 400));
      free = await isPortFree(port);
    }
  }

  return { free, ours: marked.some((p) => p.ours), killed, pids: marked };
}

module.exports = { isPortFree, findPortPids, isOurProcess, killPid, resolvePortConflict, SERVER_FILE };
