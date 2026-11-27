@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."

if exist "dist\共选主持台.exe" (
    start "" "dist\共选主持台.exe" %*
    exit /b 0
)

if exist ".venv-desktop\Scripts\pythonw.exe" (
    start "" ".venv-desktop\Scripts\pythonw.exe" host\desktop.py %*
    exit /b 0
)

if not exist ".venv\Scripts\python.exe" (
    echo 首次运行，正在准备本地虚拟环境并安装依赖...
    where py >nul 2>nul
    if %errorlevel%==0 (
        py -3.12 -m venv .venv || py -3 -m venv .venv
    ) else (
        python -m venv .venv
    )
    if errorlevel 1 (
        echo 请先安装 Python 3.12（https://www.python.org），安装时勾选 Add Python to PATH。
        pause
        exit /b 1
    )
    .venv\Scripts\python.exe -m pip install -r host\requirements-lock.txt
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

start "" http://127.0.0.1:8765
.venv\Scripts\python.exe host\server.py %*
