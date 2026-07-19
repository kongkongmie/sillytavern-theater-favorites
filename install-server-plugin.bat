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
set "installer_exit=%errorlevel%"
if not "%installer_exit%"=="0" (
    echo.
    echo [Theater Favorites] Installation failed. Review the error above.
    echo.
    pause
    exit /b %installer_exit%
)

echo.
echo [Theater Favorites] Done. Restart SillyTavern, then refresh the browser page.
echo.
pause
