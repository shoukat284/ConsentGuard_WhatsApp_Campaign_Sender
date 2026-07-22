@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo ConsentGuard clean dependency installation v2.0.5
echo Supports Node.js 22.12+ or Node.js 24, npm 10 or npm 11
echo ============================================================

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not on PATH.
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or is not on PATH.
  pause
  exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODEVER=%%i
for /f "tokens=*" %%i in ('npm -v') do set NPMVER=%%i

echo Node: %NODEVER%
echo npm : %NPMVER%

node -e "const [M,m]=process.versions.node.split('.').map(Number); process.exit(((M===22&&m>=12)||M===24)?0:1)"
if errorlevel 1 (
  echo.
  echo ERROR: Supported Node versions are 22.12 or newer in the 22 line, and all Node 24 releases.
  echo Your installed version is %NODEVER%.
  pause
  exit /b 1
)

node -e "const {execSync}=require('child_process'); const M=Number(execSync('npm -v',{encoding:'utf8'}).trim().split('.')[0]); process.exit((M===10||M===11)?0:1)"
if errorlevel 1 (
  echo.
  echo ERROR: Supported npm versions are npm 10 and npm 11.
  echo Your installed version is %NPMVER%.
  pause
  exit /b 1
)

echo.
echo Setting the official public npm registry...
call npm config set registry https://registry.npmjs.org/
if errorlevel 1 goto :failed

if exist node_modules (
  echo Removing incomplete node_modules...
  rmdir /s /q node_modules
  if exist node_modules (
    echo ERROR: node_modules could not be removed. Close VS Code and any running app instance, then retry.
    goto :failed
  )
)

echo Verifying npm cache...
call npm cache verify
if errorlevel 1 goto :failed

echo Installing exact locked dependencies...
set PUPPETEER_SKIP_DOWNLOAD=true
call npm ci --no-audit --no-fund
if errorlevel 1 goto :failed

echo Running environment diagnosis...
call npm run doctor
if errorlevel 1 goto :failed

echo Running checks...
call npm run check
if errorlevel 1 goto :failed
call npm test
if errorlevel 1 goto :failed

echo.
echo SUCCESS: Dependencies installed and tests passed.
echo Start the app with: npm start
echo Build installer and portable EXE with: npm run dist:win
pause
exit /b 0

:failed
echo.
echo INSTALLATION FAILED.
echo Review the first ERROR line above. If deletion was denied, close VS Code and retry.
pause
exit /b 1
