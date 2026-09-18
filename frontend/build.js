const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const filesToCopy = ['index.html', 'style.css', 'game.js', 'api-client.js', 'config.js', 'qrcode.min.js'];
for (const file of filesToCopy) {
  const src = path.join(__dirname, file);
  const dest = path.join(publicDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

const srcAssets = path.join(__dirname, 'assets');
const destAssets = path.join(publicDir, 'assets');
if (fs.existsSync(srcAssets)) {
  fs.cpSync(srcAssets, destAssets, { recursive: true, force: true });
}

console.log('Build completed: public directory prepared.');
