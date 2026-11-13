# Installs or updates the fork's Windows build from its latest GitHub release:
#
#   powershell -c "irm https://github.com/alexshpunt/herdr-app/releases/latest/download/install.ps1 | iex"
#
# The app goes into %LOCALAPPDATA%\Programs\herdr-app (added to your PATH for
# `herdr-app`), Herdr into the Start menu. The matching herdr-core fork is
# installed or updated as well; running terminals stay alive. An open app keeps
# running until it quits. No admin needed. Run this again for newer builds.
# HERDR_FORK_RELEASE_URL and HERDR_CORE_FORK_RELEASE_URL select test mirrors.

# Its own scope: under `irm | iex` it would otherwise set the caller's variables.
& {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# throw, not exit: under `irm | iex`, exit would close the person's window.
function Fail($why) { throw "herdr: $why" }

function Get-ForkSha256($path) {
    $stream = [IO.File]::OpenRead($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $stream.Close(); $sha.Dispose() }
}

# Use one immutable release for both the archive and its checksum.
function ForkCoreReleaseBase($release) {
    if ($release.tag_name -notmatch '^fork-[0-9]+-[0-9]+$') { Fail 'latest core release is not a fork build' }
    return "https://github.com/alexshpunt/herdr-core/releases/download/$($release.tag_name)"
}
# Download, verify and check the entire core release before changing either installation.
function Stage-ForkCore($base, $tmp, $tar) {
    $name = 'herdr-core-windows-x86_64.zip'
    $zip = Join-Path $tmp 'core.zip'
    $checksum = Join-Path $tmp 'core.sha256'
    curl.exe -fsSL "$base/$name.sha256" -o $checksum
    if ($LASTEXITCODE) { Fail "cannot download $base/$name.sha256" }
    $want = ((Get-Content -Raw -LiteralPath $checksum) -split '\s+')[0].ToLowerInvariant()
    if ($want -notmatch '^[0-9a-f]{64}$') { Fail 'invalid core checksum' }
    curl.exe -fsSL "$base/$name" -o $zip
    if ($LASTEXITCODE) { Fail "cannot download $base/$name" }
    if ((Get-ForkSha256 $zip) -ne $want) { Fail 'core checksum mismatch' }
    $entries = & $tar -tf $zip
    if ($LASTEXITCODE) { Fail 'cannot inspect core archive' }
    foreach ($entry in $entries) {
        if ($entry -match '^[/\\]' -or $entry -match '^[a-zA-Z]:' -or ($entry -split '[/\\]') -contains '..') {
            Fail 'unsafe path in core archive'
        }
    }
    $stage = Join-Path $tmp 'core'
    New-Item -ItemType Directory -Force $stage | Out-Null
    & $tar -xf $zip -C $stage
    $new = Join-Path $stage 'herdr-core.exe'
    if ($LASTEXITCODE -or -not (Test-Path -LiteralPath $new -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $stage 'conpty\conpty.dll') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $stage 'conpty\x64\OpenConsole.exe') -PathType Leaf)) {
        Fail 'core archive is incomplete'
    }
    $version = & $new --version
    if ($LASTEXITCODE -or -not ($version -match '^hc ')) { Fail 'downloaded core does not run' }
    return $stage
}

# Follow the app's configured-core and PATH order; refuse an ambiguous hc-only install.
function Find-ForkCore($dir, $configured, $path) {
    $workingCore = {
        param($candidate)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $false }
        try {
            $version = & $candidate --version 2>$null
            return ($LASTEXITCODE -eq 0 -and $version -match '^hc ')
        } catch { return $false }
    }
    if ($configured) {
        if ($configured.StartsWith('~/')) { $configured = Join-Path $env:USERPROFILE $configured.Substring(2) }
        if (-not [IO.Path]::IsPathRooted($configured)) { Fail 'configured core path must be absolute before updating' }
        if (-not (& $workingCore $configured)) { Fail "configured core does not run: $configured" }
        if ([IO.Path]::GetFileName($configured) -ine 'herdr-core.exe') { Fail "configured core must name herdr-core.exe: $configured" }
        return $configured
    }
    foreach ($folder in ($path -split ';' | Where-Object { $_ })) {
        foreach ($name in @('herdr-core.exe', 'hc.exe')) {
            $candidate = [IO.Path]::Combine($folder, $name)
            if (& $workingCore $candidate) {
                if ($name -eq 'hc.exe') { Fail "existing core $candidate has no herdr-core.exe beside it" }
                return $candidate
            }
        }
    }
    # Match the app's remaining usual locations before a custom destination.
    $usual = @((Join-Path $env:LOCALAPPDATA 'Programs\herdr-core'), (Join-Path $env:USERPROFILE '.cargo\bin'), $dir)
    foreach ($folder in $usual) {
        foreach ($name in @('herdr-core.exe', 'hc.exe')) {
            $candidate = Join-Path $folder $name
            if (& $workingCore $candidate) {
                if ($name -eq 'hc.exe') { Fail "existing core $candidate has no herdr-core.exe beside it" }
                return $candidate
            }
        }
    }
    if (Test-Path -LiteralPath (Join-Path $dir 'herdr-core.exe') -PathType Leaf) { Fail "existing core does not run: $dir" }
    return $null
}
# Replace an existing core through its updater, which keeps its terminals running.
function Install-ForkCore($source, $dir, $existing) {
    $new = Join-Path $source 'herdr-core.exe'
    if ($existing) {
        & $existing update --from $new
        if ($LASTEXITCODE) { Fail "updating $existing failed" }
    } else {
        if (Test-Path -LiteralPath $dir) { Fail "core destination already exists: $dir" }
        $parent = Split-Path -Parent $dir
        New-Item -ItemType Directory -Force $parent | Out-Null
        $stage = "$dir.install-$([guid]::NewGuid().ToString('N'))"
        try {
            New-Item -ItemType Directory $stage | Out-Null
            Copy-Item -LiteralPath $new -Destination $stage
            Copy-Item -LiteralPath (Join-Path $source 'conpty') -Destination $stage -Recurse
            $notices = Join-Path $source 'THIRD-PARTY-NOTICES'
            if (Test-Path -LiteralPath $notices) { Copy-Item -LiteralPath $notices -Destination $stage }
            New-Item -ItemType HardLink -Path (Join-Path $stage 'hc.exe') -Target (Join-Path $stage 'herdr-core.exe') | Out-Null
            Move-Item -LiteralPath $stage -Destination $dir
        } finally {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$base = if ($env:HERDR_FORK_RELEASE_URL) { $env:HERDR_FORK_RELEASE_URL.TrimEnd("/") } else { "https://github.com/alexshpunt/herdr-app/releases/latest/download" }
$coreBase = if ($env:HERDR_CORE_FORK_RELEASE_URL) {
    $env:HERDR_CORE_FORK_RELEASE_URL.TrimEnd('/')
} else {
    $release = Invoke-RestMethod 'https://api.github.com/repos/alexshpunt/herdr-core/releases/latest' -Headers @{ 'User-Agent' = 'herdr-app-installer' }
    ForkCoreReleaseBase $release
}
$coreDir = if ($env:HC_INSTALL_DIR) { $env:HC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\herdr-core' }
$dir = Join-Path $env:LOCALAPPDATA "Programs\herdr-app"
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne "AMD64") { Fail "no build for $arch Windows (x64 only)" }
$name = "herdr-app-windows-x86_64.tar.gz"
# Windows' own tar: Git Bash's, often first on PATH, takes C:\ for a remote host.
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Test-Path $tar)) {
    Fail "needs curl.exe and tar.exe (Windows 10 1803 or newer)"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "herdr-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    Write-Host "Downloading the latest Herdr fork build..."
    curl.exe -fsSL "$base/$name.sha256" -o "$tmp\app.sha256"
    if ($LASTEXITCODE) { Fail "cannot download $base/$name.sha256" }
    $want = ((Get-Content -Raw "$tmp\app.sha256") -split "\s+")[0].ToLower()
    curl.exe -fsSL "$base/$name" -o "$tmp\app.tar.gz"
    if ($LASTEXITCODE) { Fail "download failed: $base/$name" }
    # .NET, not Get-FileHash: that one fails when PowerShell 7 starts 5.1.
    $stream = [IO.File]::OpenRead("$tmp\app.tar.gz")
    try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
    if ($got -ne $want) { Fail "the download is damaged (checksum mismatch); try again" }
    & $tar -xzf "$tmp\app.tar.gz" -C $tmp
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\herdr-app\herdr-app.exe")) { Fail "the download holds no complete app" }

    Write-Host 'Downloading the latest herdr-core fork build...'
    $coreStage = Stage-ForkCore $coreBase $tmp $tar
    $appHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'herdr-app' } else { Join-Path $env:USERPROFILE '.config\herdr-app' }
    $settingsFile = Join-Path $appHome 'settings.json'
    $configured = $null
    if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
        try { $configured = (Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json).core }
        catch { Fail "cannot read $settingsFile before choosing a core" }
    }
    $coreExe = Find-ForkCore $coreDir $configured $env:Path
    if ($coreExe) {
        $foundDir = Split-Path -Parent $coreExe
        if ($env:HC_INSTALL_DIR -and [IO.Path]::GetFullPath($foundDir).TrimEnd('\') -ine [IO.Path]::GetFullPath($coreDir).TrimEnd('\')) {
            Fail "the app's core is at $coreExe, outside HC_INSTALL_DIR"
        }
        $coreDir = $foundDir
    }
    Install-ForkCore $coreStage $coreDir $coreExe

    # A running app's folder can be renamed, not deleted: the old one goes
    # now if it can, else on the next install.
    New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
    Remove-Item -Recurse -Force "$dir.old" -ErrorAction SilentlyContinue
    if (Test-Path $dir) { Rename-Item $dir "$dir.old" }
    Move-Item "$tmp\herdr-app" $dir
    Remove-Item -Recurse -Force "$dir.old" -ErrorAction SilentlyContinue

    $exe = Join-Path $dir "herdr-app.exe"
    $menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Herdr.lnk"
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
    $link.TargetPath = $exe
    $link.WorkingDirectory = $env:USERPROFILE
    $link.Description = "Terminals and coding agents that keep running"
    $link.Save()

    # The raw user PATH, so %VARIABLES% in it stay unexpanded and keep their type.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try {
        $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $changed = $false
        foreach ($path in @($dir, $coreDir)) {
            $listed = $raw -split ';' | Where-Object { $_.Trim().TrimEnd('\') -ieq $path.TrimEnd('\') }
            if (-not $listed) {
                $raw = if ($raw) { "$($raw.TrimEnd(';'));$path" } else { $path }
                $changed = $true
            }
        }
        if ($changed) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $key.SetValue('Path', $raw, $kind)
            # Setting any user variable tells running programs the environment changed.
            [Environment]::SetEnvironmentVariable('HERDR_INSTALLING', '1', 'User')
            [Environment]::SetEnvironmentVariable('HERDR_INSTALLING', $null, 'User')
        }
    } finally {
        $key.Close()
    }
    foreach ($path in @($dir, $coreDir)) {
        if (($env:Path -split ';') -notcontains $path) { $env:Path += ";$path" }
    }

    Write-Host "Herdr is installed. Quit and reopen it to use the new build, or run: herdr-app"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}
