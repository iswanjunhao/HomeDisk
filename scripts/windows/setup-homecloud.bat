@echo off
chcp 65001 >nul
REM ===========================================================================
REM  HomeCloud - 首次初始化向导（Windows）
REM  双击运行，按窗口里打印的 SETUP_WIZARD_URL 地址在浏览器打开，完成设置：
REM    1) 图形化选择要共享的目录（支持 D:\E:\ 等所有盘符，含机械硬盘）
REM    2) 设置访问端口（自动检测占用）
REM    3) 设置管理员密码、访客上传上限
REM  完成后服务会自动启动，并在项目根目录生成 start.bat（以后双击它启动）。
REM
REM  前置条件：安装 Node.js LTS for Windows（https://nodejs.org，勾选 Add to PATH）
REM ===========================================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%..\..\app"
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"

REM 定位 node：优先 PATH，其次 app\runtime\node.exe
set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_BIN=node"
) else (
  if exist "%APP_DIR%\runtime\node.exe" set "NODE_BIN=%APP_DIR%\runtime\node.exe"
)
if "%NODE_BIN%"=="" (
  echo [错误] 未找到 Node.js。请先安装：https://nodejs.org/（安装时勾选 Add to PATH）
  echo        或者把 node.exe 复制到：%APP_DIR%\runtime\node.exe
  pause
  exit /b 1
)

REM 首次运行自动安装依赖
if not exist "%APP_DIR%\node_modules" (
  echo [初始化] node_modules 不存在，正在安装依赖（仅首次，请稍候）...
  pushd "%APP_DIR%"
  call npm install --omit=dev --no-audit --no-fund
  popd
)

echo.
echo ============================================================
echo  HomeCloud 首次初始化向导启动中...
echo  请用窗口里打印的 SETUP_WIZARD_URL 地址（形如 http://127.0.0.1:xxxx/setup）
echo  在本机浏览器打开并完成设置。完成后服务自动以正式端口重启。
echo ============================================================
echo.
cd /d "%APP_DIR%"
"%NODE_BIN%" server.js
pause
