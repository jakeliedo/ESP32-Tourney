@echo off
REM Builds the EVO firmware (env: eth01evo).
REM Must run via cmd.exe, NOT git-bash directly -- git-bash injects MSYSTEM
REM into any child process it spawns, and ESP-IDF's idf_tools.py refuses to
REM run under MSYS/Mingw ("MSys/Mingw is not supported"). Running through
REM this .bat via `cmd.exe /c build.bat` avoids that.
REM
REM PLATFORMIO_CORE_DIR is set to X:\ (subst'd to C:\pio, see persisted
REM registry key HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\DOS
REM Devices) because C:\Users\<user>\.platformio is too deep a path --
REM the ESP-IDF/Matter vendor tree has files that exceed Windows' 260-char
REM MAX_PATH, and Win32 Long Path support gets reset to disabled on every
REM boot by this machine's domain Group Policy (neonuat.clubvegaming.com),
REM so shortening the path is the only fix that actually sticks.
set MSYSTEM=
set PLATFORMIO_CORE_DIR=X:\
set PATH=C:\Program Files\Python314;C:\Program Files\Python314\Scripts;C:\Program Files\Git\cmd;C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
pio run -e eth01evo
echo BUILD_EXIT_CODE=%ERRORLEVEL%
