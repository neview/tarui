# 一键发版脚本
# 用法:
#   .\release.ps1                              交互式，提示上一个版本并给出建议版本
#   .\release.ps1 patch "修复了xxx问题"        自动累加修订号
#   .\release.ps1 1.3.0 "修复了xxx问题"        指定版本号
# 第二个参数为更新说明（可选），会显示在用户的自动更新弹窗中

param(
    [Parameter(Mandatory=$false)]
    [string]$Version = "",

    [Parameter(Mandatory=$false)]
    [string]$Notes = ""
)

$ErrorActionPreference = "Stop"

# 强制控制台使用 UTF-8 输出，避免中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null

# 以最新的 git tag 为准，没有 tag 时退回 package.json
function Get-LastVersion {
    $tags = git tag -l "v*.*.*"
    if ($tags) {
        $latest = $tags |
            ForEach-Object { $_.TrimStart('v') } |
            Where-Object { $_ -match '^\d+\.\d+\.\d+$' } |
            Sort-Object { [version]$_ } |
            Select-Object -Last 1
        if ($latest) { return $latest }
    }
    return (Get-Content "package.json" -Raw | ConvertFrom-Json).version
}

function Step-Version([string]$base, [string]$level) {
    $p = $base.Split('.')
    switch ($level) {
        'major' { "{0}.0.0"     -f ([int]$p[0] + 1) }
        'minor' { "{0}.{1}.0"   -f $p[0], ([int]$p[1] + 1) }
        default { "{0}.{1}.{2}" -f $p[0], $p[1], ([int]$p[2] + 1) }
    }
}

$last    = Get-LastVersion
$suggest = Step-Version $last 'patch'

if (-not $Version) {
    Write-Host ""
    Write-Host "  上一个版本: v$last" -ForegroundColor White
    Write-Host "  建议版本  : v$suggest" -ForegroundColor Green
    Write-Host "  直接回车使用建议版本，或输入 patch / minor / major / 自定义 x.y.z" -ForegroundColor DarkGray
    $Version = Read-Host "  新版本号"
    if (-not $Version) { $Version = $suggest }
}

if ($Version -in @('patch', 'minor', 'major')) {
    $Version = Step-Version $last $Version
}
$Version = $Version.Trim().TrimStart('v', 'V')

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "版本号格式错误，应为 x.x.x（如 1.3.0）" -ForegroundColor Red
    exit 1
}

if ([version]$Version -le [version]$last) {
    Write-Host "版本号必须大于上一个版本 v$last" -ForegroundColor Red
    exit 1
}

$tag = "v$Version"

$existingTag = git tag -l $tag
if ($existingTag) {
    Write-Host "Tag $tag 已存在，请使用其他版本号" -ForegroundColor Red
    exit 1
}

if (-not $Notes) {
    $Notes = Read-Host "  请输入更新说明（直接回车跳过）"
}

Write-Host ""
Write-Host "  发版: $tag" -ForegroundColor White
if ($Notes) {
    Write-Host "  说明: $Notes" -ForegroundColor White
}
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
if ($LASTEXITCODE -ne 0) {
    Write-Host "      提交失败" -ForegroundColor Red
    exit 1
}
Write-Host "      done" -ForegroundColor Green

# 打 tag（带更新说明的 annotated tag）
# 使用临时文件传递 message，避免 Windows 命令行的中文编码问题
Write-Host "[4/5] 创建 tag $tag ..." -ForegroundColor Cyan
$msgFile = [System.IO.Path]::GetTempFileName()
try {
    $tagMessage = if ($Notes) { $Notes } else { "v$Version" }
    # 以 UTF-8 写入临时文件（git 默认使用 UTF-8 读取 tag message）
    [System.IO.File]::WriteAllText($msgFile, $tagMessage, (New-Object System.Text.UTF8Encoding $false))
    git tag -a $tag -F $msgFile --cleanup=verbatim
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      创建 tag 失败" -ForegroundColor Red
        exit 1
    }
} finally {
    Remove-Item $msgFile -ErrorAction SilentlyContinue
}
Write-Host "      done" -ForegroundColor Green

# 推送
Write-Host "[5/5] 推送到远程 ..." -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "      推送代码失败" -ForegroundColor Red
    exit 1
}
git push origin $tag
if ($LASTEXITCODE -ne 0) {
    Write-Host "      推送 tag 失败" -ForegroundColor Red
    exit 1
}
Write-Host "      done" -ForegroundColor Green

Write-Host ""
Write-Host "  ─────────────────────────" -ForegroundColor DarkGray
Write-Host "  发版完成! GitHub Actions 正在构建..." -ForegroundColor Green
Write-Host ""
Write-Host "  查看进度: https://github.com/neview/tarui/actions" -ForegroundColor Yellow
Write-Host ""
