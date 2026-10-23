'use strict';

// Renders assets/icon.png (512×512) from inline SVG:  electron dev/make-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26262b"/>
      <stop offset="1" stop-color="#0b0b0c"/>
    </linearGradient>
  </defs>
  <rect x="24" y="24" width="464" height="464" rx="112" fill="url(#g)"/>
  <rect x="25" y="25" width="462" height="462" rx="111" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <path d="M166 192 L242 256 L166 320" fill="none" stroke="#f4f4f5" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M276 322 H350" stroke="#f4f4f5" stroke-width="36" stroke-linecap="round"/>
  <circle cx="354" cy="170" r="20" fill="#3ecf8e"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const img = (await win.webContents.capturePage()).resize({ width: 512, height: 512, quality: 'best' });
  const out = path.join(__dirname, '..', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out, img.getSize());
  app.exit(0);
});
