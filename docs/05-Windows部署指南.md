# Windows 部署指南

HomeCloud 的服务端是纯 Node.js，天然跨平台。本指南说明在 Windows 上如何部署、启动、配置局域网访问，以及代码层面做了哪些 Windows 适配。

---

## 1. 前置条件

- **Windows 10 / 11**
- **Node.js LTS（Windows 版）**： https://nodejs.org
  - 安装时务必勾选 **"Add to PATH"**（添加到环境变量）
  - 验证：打开 PowerShell 输入 `node -v`，能显示版本号即成功
- 不需要 Docker、不需要数据库、不需要 IIS

> 不需要手动 `npm install`：首次双击启动脚本时，脚本会自动检测并在缺失依赖时执行安装。

---

## 2. 目录结构（Windows 视角）

解压后的目录保持与仓库一致：

```
homecloud/
├── app/                    # 服务端 + 前端
├── scripts/
│   └── windows/
│       ├── start-homecloud.bat      ← 双击启动
│       ├── install-service.ps1      ← 开机自启 + 后台运行
│       └── uninstall-service.ps1    ← 取消开机自启
└── README.md
```

---

## 3. 第一步：指定要共享的磁盘 / 文件夹

用记事本打开 `scripts/windows/start-homecloud.bat`，修改最上方的两行：

```bat
set "HOMECLOUD_ROOT=D:\"        ← 改成你真正要共享的盘符或目录，例如 D:\Share、E:\Family
set "HOMECLOUD_PORT=8080"       ← 端口，一般无需改
```

> ⚠️ 注意：以盘符根（如 `D:\`）共享时，整个 D 盘都会被暴露给局域网。如果只想共享某个文件夹，请指向具体目录（如 `D:\Share`）。

---

## 4. 第二步：启动

**方式一：前台启动（最简单）**
直接**双击** `start-homecloud.bat`。会弹出黑窗口并打印访问地址，关闭窗口即停止服务。

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

- **本机**：浏览器打开 `http://127.0.0.1:8080`
- **同局域网其他设备**（手机 / 平板 / 其他电脑）：用**这台电脑的局域网 IP**
  - 查本机 IP：PowerShell 或 CMD 输入 `ipconfig`，看「IPv4 地址」，例如 `192.168.1.20`
  - 访问 `http://192.168.1.20:8080`

> 如果手机访问不了：检查 Windows 防火墙是否放行了 8080 端口（首次运行 Node 时通常会弹窗询问，选"允许"；或手动在"高级安全 Windows Defender 防火墙"里放行入站 TCP 8080）。

---

## 6. 设置管理员密码

删除 / 重命名 / 移动文件，以及上传超过 1GB 的文件需要管理员密码。首次启动会**随机生成并打印**一个密码。想自定义：

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
| **默认共享根目录** | `config.js` 按平台取值：Windows 默认 `D:\`，Linux 默认 `/mnt/homedisk`；均可用 `HOMECLOUD_ROOT` 环境变量覆盖 |
| **磁盘容量** | 使用 `fs.statfs`，Linux / Windows 通用 |
| **Windows 保留名** | `safeName()` 自动规避 `CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9` 等 Windows 无法创建的设备名 |
| **NTFS 系统目录** | 索引器自动跳过 `$RECYCLE.BIN`、`System Volume Information` |
| **开机自启** | 用**任务计划程序**（SYSTEM）而非 Linux 的 systemd |

---

## 8. 已知注意点

- **长路径**：Windows 默认 `MAX_PATH=260`，极深的目录树（单层路径超过 ~240 字符）可能报错。一般家庭使用不会触及。
- **权限**：若目标目录是另一块 NTFS 盘且保留了旧系统 ACL，删除 / 移动可能失败。以管理员身份运行启动脚本通常即可解决；顽固情况可对该目录"取得所有权"。
- **开机自启任务的状态**：在「任务计划程序」→ `HomeCloudLAN` 可查看运行日志与上次结果。
- **换端口 / 共享目录**：都改 `start-homecloud.bat` 顶部那两行即可。
