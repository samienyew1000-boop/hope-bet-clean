const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const frontendPublicDir = path.join(publicDir, 'frontend');
if (!fs.existsSync(frontendPublicDir)) {
  fs.mkdirSync(frontendPublicDir, { recursive: true });
}

const frontendDir = path.join(__dirname, 'frontend');

// 1. Run frontend's own build if present
const frontendBuildScript = path.join(frontendDir, 'build.js');
if (fs.existsSync(frontendBuildScript)) {
  try {
    require(frontendBuildScript);
  } catch (e) {
    console.warn('Frontend build script error:', e);
  }
}

// 2. Files to populate into root public/ and public/frontend/
const filesToCopy = ['index.html', 'style.css', 'game.js', 'api-client.js', 'config.js', 'qrcode.min.js'];
for (const file of filesToCopy) {
  const src = fs.existsSync(path.join(frontendDir, file))
    ? path.join(frontendDir, file)
    : path.join(__dirname, file);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(publicDir, file));
    fs.copyFileSync(src, path.join(frontendPublicDir, file));
  }
}

// Assets
const srcAssets = fs.existsSync(path.join(frontendDir, 'assets'))
  ? path.join(frontendDir, 'assets')
  : path.join(__dirname, 'assets');

if (fs.existsSync(srcAssets)) {
  fs.cpSync(srcAssets, path.join(publicDir, 'assets'), { recursive: true, force: true });
  fs.cpSync(srcAssets, path.join(frontendPublicDir, 'assets'), { recursive: true, force: true });
}

console.log('Build completed: Root public directory and frontend subdirectories prepared.');

