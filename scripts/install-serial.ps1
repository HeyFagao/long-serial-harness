param(
    [string]$DshCommand = '',
    [string]$Archive = '',
    [string]$Profile = 'desktop'
)

# Uses the installed official dsh command; never changes PATH or execution policy.
$ErrorActionPreference = 'Stop'

if (-not $DshCommand) {
    $serialCommand = Get-Command dsh -ErrorAction SilentlyContinue
    if ($serialCommand) { $DshCommand = $serialCommand.Source }
}
if (-not $DshCommand -or -not (Test-Path -LiteralPath $DshCommand -PathType Leaf)) {
    throw '没有找到 dsh 命令。请在 Harness 应用菜单「管理 dsh 命令 / Manage dsh Command」中安装命令，重新打开 PowerShell 后重试；也可用 -DshCommand 指定官方 dsh.cmd 的完整路径。'
}

if (-not $Archive) {
    $serialCandidates = @(
        foreach ($serialDirectory in @(
            $PSScriptRoot,
            (Join-Path $PSScriptRoot '../release'),
            (Join-Path $PSScriptRoot '../packages/dsh-plugin/release')
        )) {
            if (Test-Path -LiteralPath $serialDirectory -PathType Container) {
                Get-ChildItem -LiteralPath $serialDirectory -Filter 'oh-story-dsh-*.tgz' -File
            }
        }
    )
    if ($serialCandidates.Count -ne 1) {
        throw '需要恰好一个 oh-story-dsh-*.tgz 插件包。请把本次交付的插件包放在脚本旁；有多个包时用 -Archive 指定。'
    }
    $Archive = $serialCandidates[0].FullName
}
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "找不到插件包：$Archive" }
$Archive = (Resolve-Path -LiteralPath $Archive).Path

Write-Host "Harness 命令：$DshCommand"
Write-Host "安装目标：$Profile profile"
Write-Host "插件包：$Archive"
& $DshCommand --version
if ($LASTEXITCODE -ne 0) { throw "Harness 命令启动失败，退出码 $LASTEXITCODE。" }
& $DshCommand plugin --profile $Profile add $Archive
if ($LASTEXITCODE -ne 0) { throw "插件安装失败，退出码 $LASTEXITCODE。请保留上方错误信息。" }
Write-Host ''
Write-Host '安装完成。请在保存当前工作后退出并重新打开 Harness。'
Write-Host '进入作品工作区，新建或打开会话，即可导入大纲和使用长篇连载面板。'
