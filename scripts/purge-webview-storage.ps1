<#
.SYNOPSIS
    清除 WebView2 localStorage 在磁盘上残留的明文数据。

.DESCRIPTION
    localStorage 由 WebView2 落盘在 leveldb 里，而 leveldb 是追加写 + 后台合并的：
    在界面上删掉一个值，旧值仍然会留在历史 .ldb 文件中，直到被压缩覆盖。
    v3 及更早版本的「微信部署」页把腾讯云 SecretId / SecretKey 明文存在 localStorage，
    因此即使新版本已经把密钥迁移进系统凭证管理器，磁盘上的旧副本也要单独清掉。

    脚本会先用随机字节覆写文件内容再删除，避免只是解除目录项引用。

.NOTES
    这会清空该应用的全部 localStorage，包括：主题偏好、抖音页服务器列表、
    QQ 页 Git 流水线配置。运行前请确认这些配置可以重新填写。
    存放在系统凭证管理器里的腾讯云密钥不受影响。

.EXAMPLE
    pwsh -File scripts/purge-webview-storage.ps1
    pwsh -File scripts/purge-webview-storage.ps1 -Force
#>

[CmdletBinding()]
param(
    # 跳过交互确认
    [switch]$Force,

    # 只报告命中情况，不做任何删除
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 与 src-tauri/tauri.conf.json 的 identifier 保持一致
$Identifier = 'com.tauri-app.tauri-app'
$ProcessName = 'tauri-app'

$storageRoot = Join-Path $env:LOCALAPPDATA "$Identifier\EBWebView\Default\Local Storage"

if (-not (Test-Path $storageRoot)) {
    Write-Host "未找到 localStorage 目录，无需清理：$storageRoot" -ForegroundColor Green
    exit 0
}

$running = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if ($running) {
    Write-Error "检测到 $ProcessName 正在运行（PID: $($running.Id -join ', ')），请先退出应用再执行。"
    exit 1
}

# 用存储键名做标记，判断哪些文件里还留着旧版配置；不读取也不输出任何密钥值
$markers = @(
    'weixin-deploy-config-v2',
    'weixin-deploy-config-v3'
)

$files = Get-ChildItem -Path $storageRoot -Recurse -File
$hits = @()

foreach ($file in $files) {
    $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::GetEncoding('latin1'))
    $matched = $markers | Where-Object { $text.Contains($_) }
    if ($matched) {
        $hits += [pscustomobject]@{
            File    = $file.FullName.Substring($storageRoot.Length + 1)
            Bytes   = $file.Length
            Markers = $matched -join ', '
        }
    }
}

Write-Host "localStorage 目录：$storageRoot"
Write-Host "共 $($files.Count) 个文件，其中 $($hits.Count) 个仍包含旧版部署配置。"
if ($hits.Count -gt 0) {
    $hits | Format-Table -AutoSize | Out-String | Write-Host
}

if ($DryRun) {
    Write-Host "DryRun 模式，未做任何修改。" -ForegroundColor Yellow
    exit 0
}

if (-not $Force) {
    Write-Host ""
    Write-Host "即将覆写并删除整个 localStorage 目录。" -ForegroundColor Yellow
    Write-Host "该应用的主题偏好、抖音页服务器列表、QQ 页 Git 流水线配置都会被重置。" -ForegroundColor Yellow
    Write-Host "系统凭证管理器中的腾讯云密钥不受影响。" -ForegroundColor Yellow
    $answer = Read-Host "确认继续？输入 yes"
    if ($answer -ne 'yes') {
        Write-Host "已取消。"
        exit 0
    }
}

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$overwritten = 0

foreach ($file in $files) {
    try {
        if ($file.Length -gt 0) {
            $buffer = [byte[]]::new($file.Length)
            $rng.GetBytes($buffer)
            [System.IO.File]::WriteAllBytes($file.FullName, $buffer)
        }
        $overwritten++
    }
    catch {
        Write-Warning "覆写失败，将直接删除：$($file.FullName) ($($_.Exception.Message))"
    }
}

$rng.Dispose()

Remove-Item -Path $storageRoot -Recurse -Force

Write-Host ""
Write-Host "已覆写 $overwritten 个文件并删除目录。" -ForegroundColor Green
Write-Host "下次启动应用会重建 localStorage。" -ForegroundColor Green
Write-Host ""
Write-Host "提醒：磁盘上的副本清掉了，但泄露过的密钥仍应在腾讯云控制台禁用并轮换。" -ForegroundColor Yellow
