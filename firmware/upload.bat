@echo off
REM Flashes the EVO firmware over COM7. See build.bat for why this must
REM run via cmd.exe with MSYSTEM cleared and PLATFORMIO_CORE_DIR=X:\.
REM
REM BEFORE running this, put the board in boot/download mode manually
REM (WT32-ETH01-Evo has no auto-reset circuit):
REM   1. Jumper J6-3 (GPIO9) to GND
REM   2. Reset: pulse EN (short J3-1 to GND, then release) -- if this
REM      keeps failing with "No serial data received", pulsing EN is
REM      unreliable on this board; power-cycle the board instead (unplug/
REM      replug its power) while keeping GPIO9 grounded -- see CLAUDE.md
REM      "Quy trinh vao Boot Mode" for details, confirmed more reliable.
REM   3. Remove the GPIO9 jumper
REM   4. Run this script immediately
set MSYSTEM=
set PLATFORMIO_CORE_DIR=X:\
set PATH=C:\Program Files\Python314;C:\Program Files\Python314\Scripts;C:\Program Files\Git\cmd;C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem
REM esptool's progress output contains Unicode the console's default cp1252
REM codepage can't encode, which crashes PlatformIO's log-echo thread mid-flash
REM and hangs the whole process. UTF-8 mode avoids that.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
pio run -e eth01evo --target upload
echo UPLOAD_EXIT_CODE=%ERRORLEVEL%
