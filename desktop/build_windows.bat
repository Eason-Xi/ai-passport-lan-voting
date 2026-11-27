@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

set "VENV_DIR=.venv-desktop"
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo 正在创建桌面打包虚拟环境 %VENV_DIR% ...
    where py >nul 2>nul
    if %errorlevel%==0 (
        py -3.12 -m venv "%VENV_DIR%" || py -3 -m venv "%VENV_DIR%"
    ) else (
        python -m venv "%VENV_DIR%"
    )
    if errorlevel 1 (
        echo 请先安装 Python 3.12 并勾选 Add Python to PATH。
        pause
        exit /b 1
    )
    "%VENV_DIR%\Scripts\python.exe" -m pip install -r desktop\requirements-desktop.txt
    if errorlevel 1 exit /b 1
)

echo 1/2 正在生成应用图标...
"%VENV_DIR%\Scripts\python.exe" desktop\gen_icons.py
if errorlevel 1 exit /b 1

echo 2/2 正在使用 PyInstaller 打包 Windows 单文件客户端...
"%VENV_DIR%\Scripts\pyinstaller.exe" ^
    --clean ^
    --noconfirm ^
    --distpath dist ^
    --workpath build\pyinstaller ^
    desktop\gongxuan.spec
if errorlevel 1 exit /b 1

echo.
echo 构建完成！可直接双击运行：
echo   %CD%\dist\共选主持台.exe
pause
