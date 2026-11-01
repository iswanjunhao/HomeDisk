@echo off
chcp 65001 >nul
REM ===========================================================================
REM  HomeCloud - 日常启动（Windows）
REM  如果已完成首次初始化，会自动调用项目根目录的 start.bat
REM  （端口在 start.bat 里修改：set HOMECLOUD_PORT=xxxx）
REM  否则会提示先运行初始化向导。
REM ===========================================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%..\.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"

if exist "%ROOT_DIR%\start.bat" (
  echo [启动] 使用项目根目录的 start.bat ...
  call "%ROOT_DIR%\start.bat"
  exit /b %errorlevel%
)

echo 尚未完成首次初始化。
echo 请先双击 scripts\windows\setup-homecloud.bat，在浏览器向导中完成设置，
echo 完成后会在项目根目录生成 start.bat，以后双击它即可启动。
pause
