# Exercises the core part of the fork installer without touching the user's app or core.
$ErrorActionPreference = 'Stop'
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Fail($why) { throw "herdr: $why" }

$errors = $null
$tokens = $null
$installer = Join-Path $PSScriptRoot '..\distribution\fork-install.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Get-ForkSha256', 'ForkCoreReleaseBase', 'Stage-ForkCore', 'Find-ForkCore', 'Install-ForkCore')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $function) { throw "Missing installer function: $name" }
    Invoke-Expression $function.Extent.Text
}

# The checksum and archive must use the same immutable release, even if latest changes.
$pinned = ForkCoreReleaseBase @{ tag_name = 'fork-41-2' }
Assert ($pinned -eq 'https://github.com/alexshpunt/herdr-core/releases/download/fork-41-2') 'Core release URL is not pinned'
$failed = $false
try { ForkCoreReleaseBase @{ tag_name = 'v0.1.21' } } catch { $failed = $true }
Assert $failed 'An upstream release was accepted as a fork release'
$fixture = $env:HC_TEST_CORE_FIXTURE
if (-not $fixture -or -not (Test-Path (Join-Path $fixture 'herdr-core.exe'))) { throw 'Set HC_TEST_CORE_FIXTURE to an isolated Windows core release folder.' }
$root = Join-Path ([IO.Path]::GetTempPath()) "herdr core install test $([guid]::NewGuid().ToString('N'))"
$savedLocal = $env:LOCALAPPDATA
$savedProfile = $env:USERPROFILE
$env:LOCALAPPDATA = Join-Path $root 'local'
$env:USERPROFILE = Join-Path $root 'home'
$release = Join-Path $root 'release'
$stage = Join-Path $root 'stage'
$dest = Join-Path $root 'new core'
$env:HC_SESSION = "test-fork-core-$PID"
$env:XDG_STATE_HOME = Join-Path $root 'state'
$env:XDG_CONFIG_HOME = Join-Path $root 'config'
$env:HC_SOCKET = $null
$env:HC_TERMINAL_SOCKET = $null
$env:HC_TERMINAL_ID = $null
New-Item -ItemType Directory -Force $release, $stage | Out-Null
try {
    $zip = Join-Path $release 'herdr-core-windows-x86_64.zip'
    Compress-Archive -Path (Join-Path $fixture 'herdr-core.exe'), (Join-Path $fixture 'conpty') -DestinationPath $zip
    $digest = Get-ForkSha256 $zip
    Set-Content -LiteralPath "$zip.sha256" -Value ("0" * 64)
    $base = ([uri]($release + '\')).AbsoluteUri.TrimEnd('/')
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    $failed = $false
    try { Stage-ForkCore $base $stage $tar } catch { $failed = $true }
    Assert $failed 'A bad checksum was accepted'
    Assert (-not (Test-Path $dest)) 'A bad checksum changed the destination'

    Set-Content -LiteralPath "$zip.sha256" -Value "$digest  herdr-core-windows-x86_64.zip"
    $source = Stage-ForkCore $base $stage $tar
    Install-ForkCore $source $dest $null
    $exe = Join-Path $dest 'herdr-core.exe'
    Assert (Test-Path $exe) 'Fresh install missed the executable'
    Assert (Test-Path (Join-Path $dest 'hc.exe')) 'Fresh install missed hc.exe'
    Assert (Test-Path (Join-Path $dest 'conpty\x64\OpenConsole.exe')) 'Fresh install missed ConPTY'
    Assert ((Get-ForkSha256 $exe) -eq (Get-ForkSha256 (Join-Path $fixture 'herdr-core.exe'))) 'Fresh install changed executable bytes'

    # Match the app's configured-core and PATH precedence before considering the default location.
    $otherDir = Join-Path $root 'other core'
    Install-ForkCore $source $otherDir $null
    $otherExe = Join-Path $otherDir 'herdr-core.exe'
    Assert ((Find-ForkCore $dest $null $otherDir) -eq $otherExe) 'PATH core was not selected before the default core'
    Assert ((Find-ForkCore $dest $exe $otherDir) -eq $exe) 'Configured core was not selected before PATH'
    Assert ((Find-ForkCore $dest $null '') -eq $exe) 'Default core was not found'

    # The app also looks in ~/.cargo/bin even if it is absent from PATH.
    $oldHome = $env:USERPROFILE
    $oldLocal = $env:LOCALAPPDATA
    try {
        $env:USERPROFILE = Join-Path $root 'home'
        $env:LOCALAPPDATA = Join-Path $root 'local'
        $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
        New-Item -ItemType Directory -Force $cargoBin | Out-Null
        Copy-Item -LiteralPath $exe -Destination $cargoBin
        $cargoExe = Join-Path $cargoBin 'herdr-core.exe'
        Assert ((Find-ForkCore (Join-Path $root 'missing') $null '') -eq $cargoExe) 'Cargo core was not found'
        $usual = Join-Path $env:LOCALAPPDATA 'Programs\herdr-core'
        New-Item -ItemType Directory -Force $usual | Out-Null
        Copy-Item -LiteralPath $exe -Destination $usual
        Assert ((Find-ForkCore $dest $null '') -eq (Join-Path $usual 'herdr-core.exe')) 'App default core was not selected before custom destination'
    } finally { $env:USERPROFILE = $oldHome; $env:LOCALAPPDATA = $oldLocal }

    # An existing core must use its own updater, preserving the terminal.
    $terminal = & $exe run --bg -- powershell.exe -NoProfile -Command 'Start-Sleep 60' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $terminal.address) { throw 'Isolated test terminal did not start' }
    Install-ForkCore $source $dest $exe
    $after = & $exe get $terminal.address | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read isolated terminal after update' }
    Assert ($after.state -eq 'live') 'Update lost the running terminal'

    # A corrupted release must leave both the installed binary and the live terminal alone.
    $installedHash = Get-ForkSha256 $exe
    Set-Content -LiteralPath "$zip.sha256" -Value ("0" * 64)
    $failed = $false
    try { Stage-ForkCore $base $stage $tar } catch { $failed = $true }
    Assert $failed 'A corrupted update was accepted'
    Assert ((Get-ForkSha256 $exe) -eq $installedHash) 'A corrupted update changed the installed core'
    $after = & $exe get $terminal.address | ConvertFrom-Json
    Assert ($after.state -eq 'live') 'A corrupted update disturbed the terminal'
    Write-Host 'Fork core installer checks passed.'
} finally {
    $exe = Join-Path $dest 'herdr-core.exe'
    if (Test-Path $exe) { & $exe server stop 2>$null | Out-Null }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    $env:LOCALAPPDATA = $savedLocal
    $env:USERPROFILE = $savedProfile
}
