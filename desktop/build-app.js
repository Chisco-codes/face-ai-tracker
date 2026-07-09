// Copies the web app into desktop/app before packaging.
// Run: node build-app.js && npm run dist:win
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..');
const DST = path.join(__dirname, 'app');
const FILES = ['index.html', 'app.js', 'sessions.js', 'styles.css', 'sessions.css', 'manifest.json'];
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
fs.cpSync(path.join(SRC, 'icons'), path.join(DST, 'icons'), { recursive: true });
// The service worker is a PWA concern — desktop doesn't need it, and
// registering it from file:// fails. Strip the registration if present.
let html = fs.readFileSync(path.join(DST, 'index.html'), 'utf8');
html = html.replace(/<script[^>]*>[^<]*serviceWorker[^<]*<\/script>/s, '');
fs.writeFileSync(path.join(DST, 'index.html'), html);
console.log('✓ Web app copied into desktop/app — ready to package.');
