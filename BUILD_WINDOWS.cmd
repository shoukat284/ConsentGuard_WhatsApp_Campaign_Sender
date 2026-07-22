@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules\electron\package.json (
  echo ERROR: Dependencies are not installed.
  echo Run INSTALL_WINDOWS.cmd first.
  pause
  exit /b 1
)

call npm run check
if errorlevel 1 goto :failed
call npm test
if errorlevel 1 goto :failed
call npm run dist:win
if errorlevel 1 goto :failed

echo.
echo BUILD COMPLETE.
echo Open the dist folder and send only the Setup EXE and portable EXE.
start "" "%~dp0dist"
pause
exit /b 0

:failed
echo.
echo BUILD FAILED. Review the error shown above.
pause
exit /b 1
