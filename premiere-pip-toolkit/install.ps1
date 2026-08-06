# Installs (copies) this extension into Premiere Pro's CEP extensions
# folder on Windows, and enables unsigned-extension debug mode so an
# unsigned personal panel like this one is allowed to load.

$SrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DestRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$DestDir = Join-Path $DestRoot "pip-toolkit"

New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null

if (Test-Path $DestDir) {
    Write-Host "Removing existing install at: $DestDir"
    Remove-Item -Recurse -Force $DestDir
}

Copy-Item -Recurse -Path $SrcDir -Destination $DestDir
Write-Host "Copied $SrcDir -> $DestDir"

foreach ($ver in 9,10,11,12) {
    $regPath = "HKCU:\Software\Adobe\CSXS.$ver"
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name PlayerDebugMode -Value 1 -Type String
}
Write-Host "Enabled PlayerDebugMode for CSXS 9-12."

Write-Host ""
Write-Host "Done. Restart Premiere Pro, then open:"
Write-Host "  Window > Extensions > PiP Toolkit"
