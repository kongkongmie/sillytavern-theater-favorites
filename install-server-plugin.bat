@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [Theater Favorites] Node.js was not found.
    echo [Theater Favorites] Please run this installer on the same machine where SillyTavern is installed.
    echo [Theater Favorites] If SillyTavern can start normally, open a terminal in the SillyTavern folder and run:
    echo node "%~dp0install-server-plugin.js"
    echo.
    pause
    exit /b 1
)

node "%~dp0install-server-plugin.js" %*
echo.
echo [Theater Favorites] Done. Restart SillyTavern, then refresh the browser page.
echo.
pause
