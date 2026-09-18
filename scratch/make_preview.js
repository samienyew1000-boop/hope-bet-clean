const fs = require('fs');

let html = fs.readFileSync('frontend/index.html', 'utf8');

// Super Admin preview
const saScript = '<script>localStorage.setItem("hope-bet-user", JSON.stringify({id: 1, username: "super", displayName: "Super Admin", role: "super_admin", email: "super@hope.bet.local"}));</script>';
const saHtml = html.replace('<head>', '<head>\n  ' + saScript);
fs.writeFileSync('frontend/superadmin-preview.html', saHtml, 'utf8');
fs.writeFileSync('public/superadmin-preview.html', saHtml, 'utf8');
fs.writeFileSync('public/frontend/superadmin-preview.html', saHtml, 'utf8');

// Shop Admin preview
const shopScript = '<script>localStorage.setItem("hope_bet_admin_mode", "1"); localStorage.setItem("hope-bet-user", JSON.stringify({id: 3, username: "admin", displayName: "Shop Admin", role: "admin", email: "admin@bestbet.bet"}));</script>';
const shopHtml = html.replace('<head>', '<head>\n  ' + shopScript);
fs.writeFileSync('frontend/shopadmin-preview.html', shopHtml, 'utf8');
fs.writeFileSync('public/shopadmin-preview.html', shopHtml, 'utf8');
fs.writeFileSync('public/frontend/shopadmin-preview.html', shopHtml, 'utf8');

console.log('Preview files updated');
