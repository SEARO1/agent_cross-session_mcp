<#
.SYNOPSIS
  Installs the cross-session MCP server into the live DSH home and mirrors it into my_agent_setting.
.DESCRIPTION
  Idempotent: the cordis patch row is inserted once, the skill is overwritten, the mirror copy is
  refreshed. Paths are derived from the repository location, so a fresh clone works unchanged.
.PARAMETER Commit
  Also stage the mirrored files in the my_agent_setting repository and commit them.
.PARAMETER Profile
  DSH profile to register the MCP row in (default: web).
.EXAMPLE
  pwsh -File scripts/install-to-dsh.ps1 -Commit
#>
param(
  [switch]$Commit,
  [string]$Profile = 'web'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$mirror = if ($env:CROSS_SESSION_MIRROR) { $env:CROSS_SESSION_MIRROR } else { Join-Path $env:USERPROFILE 'OneDrive/Desktop/my_agent_setting' }
if (-not (Test-Path $mirror)) {
  Write-Output ('mirror repo not found at ' + $mirror + ' - mirror step skipped')
  $mirror = $null
}

Write-Output '=== 1. skill -> DSH ==='
$skillDir = Join-Path $dsh 'skills/cross-session'
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
Copy-Item (Join-Path $root 'skills/cross-session/SKILL.md') (Join-Path $skillDir 'SKILL.md') -Force
Write-Output ('installed ' + (Join-Path $skillDir 'SKILL.md'))

Write-Output ('=== 2. MCP row -> ' + $Profile + ' profile ===')
$patch = Join-Path $dsh ('profiles/' + $Profile + '/cordis.patch.yml')
if (-not (Test-Path $patch)) { throw ('patch file not found: ' + $patch) }
$text = Get-Content $patch -Raw
if ($text -match 'mcp-cross-session') {
  Write-Output 'already registered - no change'
} else {
  $anchor = '# Old KB files + mcp-server kept in place (not deleted). Use mcp__openviking__* tools instead.'
  if ($text -notmatch [regex]::Escape($anchor)) { throw 'anchor line not found in cordis.patch.yml - add the row from install/cordis-block.yml by hand' }
  $block = (Get-Content (Join-Path $root 'install/cordis-block.yml') -Raw).TrimEnd()
  $block = $block.Replace('__ROOT__', $root).Replace('__SERVER__', (Join-Path $root 'server.mjs'))
  Copy-Item $patch ($patch + '.bak') -Force
  $text = $text.Replace($anchor, $anchor + [Environment]::NewLine + [Environment]::NewLine + $block)
  Set-Content -Path $patch -Value $text -NoNewline -Encoding utf8
  Write-Output 'inserted mcp-cross-session row (backup written next to the patch file)'
}

if ($null -eq $mirror) { Write-Output '=== done (no mirror) ==='; exit 0 }

Write-Output '=== 3. mirror -> my_agent_setting ==='
$target = Join-Path $mirror 'mcp/agent-cross-session-mcp'
foreach ($dir in @('lib', 'skills/cross-session', 'install', 'scripts')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $target $dir) | Out-Null
}
foreach ($file in @('server.mjs', 'test.mjs', 'package.json', 'README.md', '.gitignore')) {
  Copy-Item (Join-Path $root $file) (Join-Path $target $file) -Force
}
Copy-Item (Join-Path $root 'lib/*.mjs') (Join-Path $target 'lib') -Force
Copy-Item (Join-Path $root 'skills/cross-session/SKILL.md') (Join-Path $target 'skills/cross-session') -Force
Copy-Item (Join-Path $root 'install/cordis-block.yml') (Join-Path $target 'install') -Force
Copy-Item (Join-Path $root 'scripts/install-to-dsh.ps1') (Join-Path $target 'scripts') -Force
Copy-Item (Join-Path $skillDir 'SKILL.md') (Join-Path $mirror 'skills/cross-session/SKILL.md') -Force
Copy-Item $patch (Join-Path $mirror 'cordis.patch.yml') -Force
Copy-Item (Join-Path $dsh 'AGENTS.md') (Join-Path $mirror 'AGENTS.md') -Force
Write-Output ('mirrored to ' + $target)

if ($Commit) {
  Write-Output '=== 4. commit mirror ==='
  git -C $mirror add AGENTS.md cordis.patch.yml skills/cross-session mcp/agent-cross-session-mcp
  git -C $mirror status --short
  git -C $mirror commit -m 'chore: sync cross-session MCP server, skill, AGENTS.md rule 12'
}
Write-Output '=== done ==='
