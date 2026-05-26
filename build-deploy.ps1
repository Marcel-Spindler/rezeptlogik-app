$nodeVersion = "v20.11.1"
$destFolder = "$PSScriptRoot\.node"
$nodePath = "$destFolder\node-$nodeVersion-win-x64"
$env:PATH = "$nodePath;$env:PATH"

Write-Host "Node.js installed at $nodePath"
& "$nodePath\node.exe" -v
& "$nodePath\npm.cmd" -v

Write-Host "Running npm install..."
& "$nodePath\npm.cmd" install

Write-Host "Running npm run build..."
& "$nodePath\npm.cmd" run build

Write-Host "Deploying to Firebase Hosting..."
& "$nodePath\npx.cmd" firebase-tools deploy --only hosting

Write-Host "Done."