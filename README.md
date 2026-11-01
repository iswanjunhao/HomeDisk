# HomeCloud · 家庭局域网私有云盘

> 一台电脑的硬盘，家里所有设备（手机 / 平板 / 电脑）都能通过浏览器直接访问、上传、下载、整理文件。自带图形界面，无需 Docker，纯 Node.js 实现。

---

## 一、项目简介

HomeCloud 是一个**轻量的家庭局域网网盘**。把它跑在家里的某台电脑上，这台电脑的一个磁盘就成了"私有云"——只要设备连着同一个 WiFi / 局域网，打开浏览器输入地址就能像用网盘一样浏览、上传、下载、管理文件。

- **零外部依赖**：不需要 Docker、不需要数据库、不需要 Nginx。只依赖 5 个 npm 包。
- **跨平台**：同一套代码同时支持 Linux 与 Windows（路径、编码、启动方式均已适配）。
- **安全边界**：默认只允许局域网 IP 访问；破坏性操作（删除 / 重命名 / 移动 / 大文件上传）需要管理员密码；路径做了严格的越权防护。

> 设计定位是**家庭内部使用**，请不要把端口映射到公网，也不要做内网穿透。

---

## 二、功能特性

| 功能 | 说明 |
|---|---|
| 📂 文件夹浏览 | 网格 / 列表双视图，面包屑导航，移动端「← 返回上一级」按钮 |
| ⬆️ 上传 | 多文件、拖拽、手机拍照上传；分片传输 + 进度条 + 断点续传 |
| ⬇️ 下载 | 单文件断点续传（支持视频拖动进度条）；多选打包成 ZIP 下载 |
| 🔍 搜索 | 文件名模糊搜索，全盘 / 当前目录范围可选，后台索引毫秒级响应 |
| 🗂️ 文件夹管理 | 新建、重命名、移动（弹窗选目录 + 拖拽 + 剪切粘贴）、批量删除 |
| 🔐 权限 | 访客默认可浏览 + 上传（≤1GB 免密）；破坏性操作需管理员密码 |
| 📱 移动端适配 | 手机 / 平板浏览器自适应布局 |
| 🖼️ 图片缩略图 | 网格视图自动生成缩略图（可选，缺失也不影响其他功能） |
| 💾 磁盘容量 | 实时显示共享盘已用 / 剩余空间 |

---

## 三、项目结构

```
homecloud/                          # 仓库根目录
├── README.md                       # 本文件
├── LICENSE                         # MIT 许可证
├── .gitignore                      # 排除依赖 / 数据 / 日志 / 运行时
├── app/                            # 服务端 + 前端源码（核心交付）
│   ├── server.js                   # 服务入口
│   ├── package.json                # 依赖与脚本
│   ├── public/                     # 纯前端（无需构建）
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   └── src/
│       ├── lib/                    # 基础库（路径安全 / 配置 / 认证 / 索引 / 分类 / 格式化）
│       └── routes/                 # 各 API 路由
├── docs/                           # 设计文档与使用说明
│   ├── 01-需求文档.md
│   ├── 02-开发提示词.md
│   ├── 03-使用说明.md
│   ├── 04-技术架构.md
│   └── 05-Windows部署指南.md
└── scripts/
    ├── install.sh                  # Linux：一键安装（挂载+装依赖+设密码+systemd 自启）
    ├── mount-disk.sh               # Linux：挂载 NTFS 共享盘到 /mnt/homedisk
    └── windows/
        ├── start-homecloud.bat      # Windows：双击启动
        ├── install-service.ps1      # Windows：注册开机自启 + 后台运行
        └── uninstall-service.ps1    # Windows：取消开机自启
```

---

## 四、核心模块职责

> 更详细的架构说明见 [`docs/04-技术架构.md`](docs/04-技术架构.md)。

| 模块 | 职责 |
|---|---|
| `server.js` | 入口：加载配置、初始化路径守卫、首启自动生成管理员密码、挂载路由、打印局域网地址、启动后台索引 |
| `src/lib/pathGuard.js` | **最关键的防护**：路径归一化 → 拼接 → `realpath` → 前缀比对，防 `../` 穿越、URL 编码绕过、符号链接逃逸；文件名清洗（含 Windows 保留名）、同名自动重命名 |
| `src/lib/config.js` | 配置管理：默认值 + 环境变量覆盖 + scrypt 密码哈希 + 配置读写（跨平台默认共享根目录） |
| `src/lib/auth.js` | 管理员认证与会话：scrypt 校验、httpOnly Cookie、失败限流、局域网 IP 判定 |
| `src/lib/indexer.js` | 后台全文索引：启动全量扫描、内存缓存 + 落盘、定时增量、搜索优先走索引、未就绪时实时遍历兜底 |
| `src/lib/classifier.js` | 文件分类：按扩展名归入图片 / 视频 / 音频 / 文档 / 压缩包 / 其他 |
| `src/lib/format.js` | 格式化：文件大小、时间、相对时间 |
| `src/routes/files.js` | 目录列表、磁盘容量（`statfs`）、单文件下载（Range 断点续传）、ZIP 打包下载、图片缩略图 |
| `src/routes/upload.js` | 分片上传（init→chunk→done），1GB 访客上限权限闸门，`.hcpart` 临时文件与超时清理 |
| `src/routes/manage.js` | 文件夹管理：新建 / 重命名 / 移动 / 删除 / 目录树 / 可选回收站 |
| `src/routes/search.js` | 搜索接口（索引优先，实时兜底） |
| `src/routes/auth.js` | 登录 / 登出接口 |
| `public/` | 前端：纯浏览器 JS，无需打包构建；双视图、面包屑、多选、拖拽移动、搜索、管理员密码拦截、移动端适配 |

---

## 五、依赖清单

运行时仅 5 个 npm 包（`app/package.json`）：

| 依赖 | 用途 |
|---|---|
| `express` | HTTP 服务与路由 |
| `sharp` | 图片缩略图生成（原生模块，缺省时自动降级） |
| `archiver` | 多选文件流式打包成 ZIP |
| `cookie-parser` | 解析管理员会话 Cookie |
| `mime-types` | 下载时推断文件 MIME 类型 |

> 前端**没有任何 npm 依赖**，不引入框架、不需要 `npm run build`。

---

## 六、快速开始

### 方式 A：Linux（Ubuntu / Debian 等）

```bash
# 一键安装：挂载共享盘 → 装依赖 → 设管理员密码 → 注册 systemd 开机自启
sudo bash scripts/install.sh
```

安装完成后会打印局域网访问地址，形如 `http://192.168.1.x:8080`。

想直接跑源码（开发模式）：

```bash
cd app
npm install
node server.js            # 首启会随机生成管理员密码并打印到终端
```

### 方式 B：Windows

1. 安装 **Node.js LTS（Windows 版）**，安装时勾选 **"Add to PATH"**：https://nodejs.org
2. 用记事本打开 `scripts/windows/start-homecloud.bat`，把第一行的共享目录改成你真正要共享的盘符 / 文件夹：
   ```bat
   set "HOMECLOUD_ROOT=D:\"          ← 改成例如 D:\Share 或 E:\
   ```
3. **双击** `start-homecloud.bat` 启动，浏览器访问 `http://127.0.0.1:8080`
4. （可选，开机自启 + 后台运行）右键 `scripts/windows/install-service.ps1` → **"使用 PowerShell 运行"**（建议以管理员身份）

> 详细 Windows 说明见 [`docs/05-Windows部署指南.md`](docs/05-Windows部署指南.md)。

---

## 七、配置说明

配置持久化在 `app/data/config.json`，可用环境变量临时覆盖（便于部署脚本一次性设定）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `root` | Linux `/mnt/homedisk`；Windows `D:\` | 共享根目录；推荐用环境变量 `HOMECLOUD_ROOT` 显式指定 |
| `port` | `8080` | 监听端口；环境变量 `HOMECLOUD_PORT` |
| `adminPasswordHash` | 首启随机生成 | 管理员密码哈希（scrypt）；命令行改密见下 |
| `guestUploadMaxBytes` | `1073741824`（1GB） | 访客免密上传的单文件上限；`0` 表示禁止访客上传；环境变量 `HOMECLOUD_UPLOAD_LIMIT` |
| `sessionHours` | `8` | 管理员登录有效期（小时） |
| `indexIntervalMinutes` | `30` | 全盘索引刷新间隔（分钟） |
| `trashDir` | `''`（直接删除） | 设为某目录后，删除改为移入回收站，误删可救；环境变量 `HOMECLOUD_TRASH` |
| `lanOnly` | `true` | 仅允许局域网 IP 访问（家庭网盘的基本安全边界） |

**常用命令**

```bash
# 修改 / 设置管理员密码
node server.js --set-password 你的密码

# 首次自动生成的密码忘了？直接重设即可
node server.js --set-password 新密码
```

---

## 八、常见问题（FAQ）

**Q1：手机 / 其他设备怎么访问？**
用这台电脑的**局域网 IP** 访问，例如 `http://192.168.1.14:8080`。
- Windows 查 IP：命令行 `ipconfig`，看「IPv4 地址」
- Linux 查 IP：`hostname -I` 或 `ip a`
- 浏览器启动时也会把地址打印在终端。

**Q2：访客能随便上传吗？**
默认可以上传，但**单个文件超过 1GB 需要管理员密码**。若想完全禁止访客上传，把 `guestUploadMaxBytes` 设为 `0`（环境变量 `HOMECLOUD_UPLOAD_LIMIT=0`）。

**Q3：删除 / 移动某些文件提示失败？**
- **Windows**：目标目录可能保留了旧系统的只读权限（如 `WindowsApps`）。以管理员身份运行启动脚本，或参考 Windows 部署指南处理 NTFS 权限。
- **Linux**：确认共享盘是用 `scripts/mount-disk.sh` 挂载的（带 `noacsrules`，忽略 Windows ACL）。

**Q4：中文文件名下载乱码？**
不会。下载头已按 RFC 5987 同时下发 ASCII 兜底名和 UTF-8 名，Windows / macOS / 手机均正常。

**Q5：端口被占用 / 想换端口？**
改 `HOMECLOUD_PORT` 环境变量（Linux 写在 systemd 的 `Environment=`，Windows 写在 `start-homecloud.bat`）。

**Q6：图片缩略图不显示？**
说明 `sharp`（原生模块）未加载，这**只影响网格视图的缩略图**，文件浏览 / 上传 / 下载 / 搜索不受影响。重新 `npm install` 即可。

**Q7：能映射到公网 / 做内网穿透吗？**
**不建议**。本系统设计为家庭局域网内部使用，安全模型只覆盖局域网边界。不要做端口映射或内网穿透。

**Q8：Windows 开机自启后没生效？**
- 确认以管理员运行过 `install-service.ps1`；
- 任务计划程序里查看 `HomeCloudLAN` 任务的状态；
- 若 PowerShell 提示禁止脚本，先执行 `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`。

---

## 九、安全声明

- 默认仅接受局域网私有网段（`10.x` / `192.168.x` / `172.16-31.x` / `127.x` / `169.254.x`）的请求。
- 路径访问经过 `realpath` + 前缀比对，杜绝 `../` 穿越、URL 编码绕过、符号链接逃逸。
- 破坏性操作一律要求管理员密码；会话用服务端 Cookie，登出即失效。
- 请在可信的家庭网络内使用，不要暴露到公网。

---

## 许可证

[MIT](LICENSE) © 2026 HomeCloud contributors
