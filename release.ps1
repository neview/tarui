# 一键发版脚本
# 用法: .\release.ps1 1.3.0

param(
    [Parameter(Mandatory=$true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "版本号格式错误，应为 x.x.x（如 1.3.0）" -ForegroundColor Red
    exit 1
}

$tag = "v$Version"

$existingTag = git tag -l $tag
if ($existingTag) {
    Write-Host "Tag $tag 已存在，请使用其他版本号" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  发版: $tag" -ForegroundColor White
Write-Host "  ─────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# 更新 tauri.conf.json 版本号
Write-Host "[1/5] 更新 tauri.conf.json 版本号 ..." -ForegroundColor Cyan
$tauriConf = Get-Content "src-tauri/tauri.conf.json" -Raw
$tauriConf = $tauriConf -replace '"version": ".*?"', "`"version`": `"$Version`""
Set-Content "src-tauri/tauri.conf.json" $tauriConf -NoNewline
Write-Host "      done" -ForegroundColor Green

# 更新 package.json 版本号
Write-Host "[2/5] 更新 package.json 版本号 ..." -ForegroundColor Cyan
$pkgJson = Get-Content "package.json" -Raw
$pkgJson = $pkgJson -replace '"version": ".*?"', "`"version`": `"$Version`""
Set-Content "package.json" $pkgJson -NoNewline
Write-Host "      done" -ForegroundColor Green

# 提交
Write-Host "[3/5] 提交代码 ..." -ForegroundColor Cyan
git add .
git commit -m "release: v$Version"
Write-Host "      done" -ForegroundColor Green

# 打 tag
Write-Host "[4/5] 创建 tag $tag ..." -ForegroundColor Cyan
git tag $tag
Write-Host "      done" -ForegroundColor Green

# 推送
Write-Host "[5/5] 推送到远程 ..." -ForegroundColor Cyan
git push
git push origin $tag
Write-Host "      done" -ForegroundColor Green

Write-Host ""
Write-Host "  ─────────────────────────" -ForegroundColor DarkGray
Write-Host "  发版完成! GitHub Actions 正在构建..." -ForegroundColor Green
Write-Host ""
Write-Host "  查看进度: https://github.com/neview/tarui/actions" -ForegroundColor Yellow
Write-Host "  构建完成后去 Releases 页面点 Publish" -ForegroundColor Yellow
Write-Host ""
