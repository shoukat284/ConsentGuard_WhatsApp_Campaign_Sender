$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$nodeVersion = node -v
$npmVersion = npm -v
Write-Host "Node: $nodeVersion"
Write-Host "npm : $npmVersion"

$nodeParts = $nodeVersion.TrimStart('v').Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = [int]$nodeParts[1]
$nodeSupported = (($nodeMajor -eq 22 -and $nodeMinor -ge 12) -or $nodeMajor -eq 24)
if (-not $nodeSupported) {
    throw "Supported Node versions are 22.12+ or 24.x. Installed: $nodeVersion"
}

$npmMajor = [int]($npmVersion.Split('.')[0])
if ($npmMajor -notin @(10, 11)) {
    throw "Supported npm versions are 10.x or 11.x. Installed: $npmVersion"
}

npm config set registry https://registry.npmjs.org/

if (Test-Path '.\node_modules') {
    Remove-Item '.\node_modules' -Recurse -Force
}

$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm cache verify
npm ci --no-audit --no-fund
npm run doctor
npm run check
npm test

Write-Host "`nInstallation complete." -ForegroundColor Green
Write-Host 'Run: npm start'
Write-Host 'Build: npm run dist:win'
