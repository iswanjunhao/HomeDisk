# Windows 部署指南

HomeCloud 的服务端是纯 Node.js，天然跨平台。本指南说明在 Windows 上如何完成**图形化初始化**、日常启动、开机自启，以及代码层面做了哪些 Windows 适配。

---

## 1. 前置条件

- **Windows 10 / 11**
- **Node.js LTS（Windows 版）**： https://nodejs.org
  - 安装时务必勾选 **"Add to PATH"**（添加到环境变量）
  - 验证：打开 PowerShell 输入 `node -v`，能显示版本号即成功
- 不需要 Docker、不需要数据库、不需要 IIS

> 不需要手动 `npm install`：首次运行初始化脚本时会自动检测并在缺失依赖时安装。

---

## 2. 目录结构（Windows 视角）

```
homecloud/
├── app/                            # 服务端 + 前端
├── scripts/
│   └── windows/
│       ├── setup-homecloud.bat     ← 第一步：双击运行初始化向导
│       ├── start-homecloud.bat     ← 日常启动（自动调用根目录 start.bat）
│       ├── install-service.ps1     ← 开机自启 + 后台运行
│       └── uninstall-service.ps1   ← 取消开机自启
└── README.md
```

---

## 3. 第一步：图形化初始化向导

1. **双击 `scripts\windows\setup-homecloud.bat`**（首次会自动安装依赖，请稍候）
2. 按窗口里打印的 `SETUP_WIZARD_URL` 地址（形如 `http://127.0.0.1:xxxx/setup`）在本机浏览器打开向导
3. 在向导里完成三步（全程鼠标点选，无需命令行）：
   - **选择要共享的目录**：点「💽 磁盘」可直达所有盘符（C:\、D:\、E:\… 含机械硬盘）；可整盘共享，也可展开只共享某个子文件夹，支持添加多个
   - **设置访问端口**：输入即实时检测占用；被旧的 HomeCloud 进程占用会在完成时自动停止，被其他程序占用会提示换端口
   - **管理员密码 / 访客上传上限 / 仅局域网**
4. 点击「完成设置并启动」——服务自动以选定端口重启，页面展示局域网访问地址
5. 项目根目录会生成 **`start.bat`**，**以后双击它启动即可**（`scripts\windows\start-homecloud.bat` 也会自动调用它）

> ⚠️ 以盘符根（如 `D:\`）共享时，整个 D 盘都会暴露给局域网。只想共享某个文件夹的话，请在向导里展开到具体目录再点「加入共享」。

> 端口保存在 `start.bat` 里（`set HOMECLOUD_PORT=xxxx`），**不在 config.json 中**。想换端口：用记事本改 `start.bat` 里那一行数字，保存后重新运行。

---

## 4. 第二步：日常启动

**方式一：前台启动（最简单）**
双击根目录的 **`start.bat`**（或 `scripts\windows\start-homecloud.bat`，效果相同）。关闭窗口即停止服务。

**方式二：后台运行（开机自启，推荐）**
1. 右键 `scripts/windows/install-service.ps1`
2. 选择 **"使用 PowerShell 运行"**（建议以**管理员**身份）
3. 脚本会注册一个名为 `HomeCloudLAN` 的**任务计划程序**任务：
   - 触发：**系统启动时**自动运行
   - 运行身份：**SYSTEM**（无需登录用户也能跑）
   - 窗口：**隐藏**（不弹黑窗）
4. 之后每次开机自动启动，无需手动操作。

取消自启：右键 `uninstall-service.ps1` → "使用 PowerShell 运行"。

> 若 PowerShell 提示"无法加载脚本"，先执行一次：
> `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`
> （从 GitHub 下载的 `.ps1` 可能被系统标记为来自 Internet，右键文件 → 属性 → 勾选"解除锁定"也可。）

---

## 5. 第三步：访问

- **本机**：浏览器打开 `http://127.0.0.1:端口`（向导完成页会直接列出）
- **同局域网其他设备**（手机 / 平板 / 其他电脑）：用**这台电脑的局域网 IP**
  - 查本机 IP：PowerShell 或 CMD 输入 `ipconfig`，看「IPv4 地址」，例如 `192.168.1.20`
  - 访问 `http://192.168.1.20:端口`

> 如果手机访问不了：检查 Windows 防火墙是否放行了对应端口（首次运行 Node 时通常会弹窗询问，选"允许"；或手动在"高级安全 Windows Defender 防火墙"里放行入站 TCP 端口）。

---

## 6. 管理员密码

向导中已设置。之后想改密：

```powershell
cd homecloud\app
node server.js --set-password 你的密码
```

---

## 7. 代码层面的 Windows 适配点

本项目的服务端代码**无需改动即可在 Windows 运行**，已处理以下平台差异：

| 差异点 | 处理方式 |
|---|---|
| **路径分隔符** | 所有内部路径用 `path.join` / `path.resolve` / `path.relative`（OS 自适应）；对外接口统一用 `/`，由 `pathGuard.toRel` / `resolveSafe` 在 POSIX 与 Windows 风格间转换 |
| **文件编码 / 中文名** | Node 在 Windows 原生处理 UTF-16 文件系统路径；下载时 `Content-Disposition` 按 RFC 5987 下发 UTF-8 文件名，避免中文名乱码 |
| **磁盘枚举** | `volumes.js` 在 Windows 上枚举盘符（C:\ ~ Z:\），浏览器根目录每个盘符一键直达；Linux 则解析 `/proc/mounts` |
| **端口占用检测** | `portutils.js`：Windows 用 `netstat -ano` + `wmic` 识别进程；Linux 用 `ss` + `/proc/<pid>/cmdline`。两者都只自动结束本服务进程 |
| **启动器** | 初始化完成后按平台生成：Windows 生成 `start.bat`，Linux 生成 `start.sh`；端口都只存在启动器里 |
| **目录浏览器** | 盘符根（`C:\` 等）视为文件系统根，能列出所有磁盘入口；Linux 下则是 `/` |
| **共享目录容量** | 使用 `fs.statfs`，Linux / Windows 通用 |
| **Windows 保留名** | `safeName()` 自动规避 `CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9` 等 Windows 无法创建的设备名 |
| **NTFS 系统目录** | 索引器自动跳过 `$RECYCLE.BIN`、`System Volume Information` |
| **开机自启** | 用**任务计划程序**（SYSTEM）而非 Linux 的 systemd |

---

## 8. 已知注意点

- **长路径**：Windows 默认 `MAX_PATH=260`，极深的目录树（单层路径超过 ~240 字符）可能报错。一般家庭使用不会触及。
- **权限**：若目标目录是另一块 NTFS 盘且保留了旧系统 ACL，删除 / 移动可能失败。以管理员身份运行启动脚本通常即可解决；顽固情况可对该目录"取得所有权"。
- **开机自启任务的状态**：在「任务计划程序」→ `HomeCloudLAN` 可查看运行日志与上次结果。
- **换端口**：编辑根目录 `start.bat` 里的 `HOMECLOUD_PORT`，保存后重新运行。
- **换 / 增加共享目录**：打开网页 →「管理员」解锁 →「管理共享目录」，图形化操作即可，无需改配置文件。
