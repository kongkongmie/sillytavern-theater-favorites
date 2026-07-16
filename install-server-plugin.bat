@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node "%~dp0install-server-plugin.js"
echo.
echo 完成后请重启 SillyTavern，再刷新浏览器页面。
echo.
pause
