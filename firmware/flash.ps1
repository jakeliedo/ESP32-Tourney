# flash.ps1 - nap firmware EVO voi tu dong retry cho toi khi thanh cong.
#
# Vi sao can file nay (2026-09-14): esptool sync ("Connecting....") flake tren
# adapter FTDI/laptop nay ngay ca khi chip da vao dung ROM download mode that
# su (da xac nhan bang cach doc truc tiep banner "waiting for download" qua
# serial trong luc mot lan upload dang bao "No serial data received"). ROM
# khong tu thoat download mode theo thoi gian, nen cu retry la se vao duoc,
# khong can lam lai jumper moi lan.
#
# Dung: cd firmware; ./flash.ps1
#       ./flash.ps1 -MaxAttempts 8 -TargetEnv eth01evo

param(
    [int]$MaxAttempts = 5,
    [string]$TargetEnv = "eth01evo"
)

$ErrorActionPreference = "Continue"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

Set-Location $PSScriptRoot

function Clear-StaleUploadProcesses {
    Get-Process -Name "python", "pio" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

Write-Host "Nap firmware env '$TargetEnv', toi da $MaxAttempts lan thu." -ForegroundColor Cyan
Write-Host "Dam bao board da o boot mode (GPIO9->GND, pulse EN, tha GPIO9) truoc khi bat dau.`n" -ForegroundColor Cyan

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Write-Host "=== Lan thu $attempt / $MaxAttempts ===" -ForegroundColor Yellow
    Clear-StaleUploadProcesses

    & pio run -e $TargetEnv --target upload
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        Write-Host "`n=== THANH CONG (lan thu $attempt) ===" -ForegroundColor Green
        exit 0
    }

    Write-Host "`nLan thu $attempt that bai (exit code $exitCode)." -ForegroundColor Red

    if ($attempt -lt $MaxAttempts) {
        Write-Host "Board van dang cho o download mode (ROM khong tu timeout)." -ForegroundColor Yellow
        Write-Host "Neu 40 lan connect-attempts ben trong cung khong vao duoc, co the board" -ForegroundColor Yellow
        Write-Host "da thoat boot mode that (rut day, mat nguon...). Lam lai jumper neu can," -ForegroundColor Yellow
        Write-Host "roi nhan Enter de thu lai ngay -- khong can lam lai jumper neu ban nghi" -ForegroundColor Yellow
        Write-Host "board van con o boot mode." -ForegroundColor Yellow
        Read-Host "Nhan Enter de thu lai" | Out-Null
    }
}

Write-Host "`n=== THAT BAI sau $MaxAttempts lan. Kiem tra: FTDI con cam chac khong," -ForegroundColor Red
Write-Host "jumper GPIO9/EN co tiep xuc tot khong, nguon 3.3V tren FTDI (khong phai 5V)." -ForegroundColor Red
exit 1
