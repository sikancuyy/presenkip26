# Presensi KIP 2026 - Quick Deploy Script
param (
    [string]$msg = "update: auto-deploy changes"
)

Write-Host "🚀 Menyiapkan deployment Presensi KIP 2026..." -ForegroundColor Cyan
git add -A
$status = git status --porcelain
if ($status) {
    git commit -m $msg
} else {
    Write-Host "ℹ️ Tidak ada file baru yang diubah. Memaksa push ke VPS & GitHub..." -ForegroundColor Yellow
    git push origin main
}

Write-Host "✅ Selesai! Kode telah terdeploy otomatis ke GitHub dan VPS." -ForegroundColor Green

