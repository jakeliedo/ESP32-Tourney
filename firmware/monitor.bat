@echo off
REM Opens the serial monitor on COM7 (115200 baud). See build.bat for why
REM this must run via cmd.exe with MSYSTEM cleared.
set MSYSTEM=
set PLATFORMIO_CORE_DIR=X:\
set PATH=C:\Program Files\Python314;C:\Program Files\Python314\Scripts;C:\Program Files\Git\cmd;C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
pio device monitor -e eth01evo
