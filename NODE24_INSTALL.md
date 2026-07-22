# Node.js 24 installation instructions — v2.0.5

This release supports the existing Node.js 24/npm 11 installation. Do not uninstall or downgrade Node.js.

## Clean installation

Open PowerShell in the project folder and run:

```powershell
Remove-Item -Recurse -Force .\node_modules -ErrorAction SilentlyContinue
Remove-Item -Force .\node_modules\.package-lock.json -ErrorAction SilentlyContinue
npm cache verify
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
npm install --no-audit --no-fund
npm run doctor
npm run check
npm test
npm start
```

Alternatively, double-click `INSTALL_WINDOWS.cmd`.

Supported source-build versions:

- Node.js 24.x with npm 11.x
- Node.js 22.12+ with npm 10.x

The deprecation lines printed by npm are warnings from transitive dependencies. Installation is successful when npm finishes with `added ... packages` and does not finish with `npm error`.
