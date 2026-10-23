'use strict';

// Renders dev/promo/promo.html to video, frame by frame (deterministic).
//   electron dev/promo/render.js                 -> docs/promo/pult-promo.mp4 + poster.png + preview.gif
//   electron dev/promo/render.js --vertical      -> docs/promo/pult-promo-vertical.mp4
//   electron dev/promo/render.js --stills 3,12.5 -> PNG stills only (for checking)
// Env: PROMO_TMP = folder for frames (keep it short, default %TEMP%\pult-promo).

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FFMPEG = path.join(ROOT, '.tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const OUT = path.join(ROOT, 'docs', 'promo');
const FPS = 30;

const args = process.argv.slice(2);
const vertical = args.includes('--vertical');
const stillsArg = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null;
const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
const TMP = path.join(process.env.PROMO_TMP || path.join(os.tmpdir(), 'pult-promo'), vertical ? 'v' : 'h');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

function ffmpeg(list) {
  console.log('ffmpeg', list.join(' '));
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...list], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
}

async function main() {
  const win = new BrowserWindow({
    width: W,
    height: H + 4,
    show: false,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.setContentSize(W, H + 4);
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (e) => console.log('[page]', e.message));
  await win.loadFile(path.join(__dirname, 'promo.html'), { query: vertical ? { v: '1' } : {} });
  const info = await win.webContents.executeJavaScript('window.ready');
  console.log('page ready', info);

  // Offscreen capture can return the previous frame, so every frame carries a
  // colour-coded id in a 4 px strip below the picture; retry until it matches.
  let seq = 0;
  const grab = async (t) => {
    const id = (++seq) & 0xffff;
    await win.webContents.executeJavaScript(
      `seek(${t}, ${id}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
    );
    for (let attempt = 0; attempt < 40; attempt++) {
      let img = await win.webContents.capturePage();
      const s = img.getSize();
      if (s.width !== W || s.height !== H + 4) throw new Error(`capture is ${s.width}x${s.height}, expected ${W}x${H + 4}`);
      const px = img.crop({ x: 6, y: H + 1, width: 1, height: 1 }).toBitmap(); // BGRA
      if (px[2] === (id & 255) && px[1] === ((id >> 8) & 255)) return img.crop({ x: 0, y: 0, width: W, height: H }).toPNG();
      await new Promise((r) => setTimeout(r, 15));
    }
    const dbg = await win.webContents.capturePage();
    const b = dbg.crop({ x: 6, y: H + 1, width: 1, height: 1 }).toBitmap();
    throw new Error(`frame at t=${t} never painted (size ${JSON.stringify(dbg.getSize())}, px ${[...b]}, want id ${id})`);
  };

  fs.mkdirSync(TMP, { recursive: true });

  if (stillsArg) {
    for (const t of stillsArg.split(',').map(Number)) {
      const file = path.join(TMP, `still-${t.toFixed(2)}.png`);
      fs.writeFileSync(file, await grab(t));
      console.log('still', file);
    }
    return;
  }

  for (const f of fs.readdirSync(TMP)) if (f.startsWith('f')) fs.rmSync(path.join(TMP, f));
  const total = Math.round(info.duration * FPS);
  for (let i = 0; i < total; i++) {
    fs.writeFileSync(path.join(TMP, `f${String(i).padStart(5, '0')}.png`), await grab(i / FPS));
    if (i % 150 === 0) console.log(`frame ${i}/${total}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const name = vertical ? 'pult-promo-vertical.mp4' : 'pult-promo.mp4';
  const mp4 = path.join(OUT, name);
  ffmpeg([
    '-framerate', String(FPS), '-i', path.join(TMP, 'f%05d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-tune', 'animation',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', mp4,
  ]);

  if (!vertical) {
    // Poster: the reconnected terminal, headline visible.
    fs.writeFileSync(path.join(OUT, 'poster.png'), await grab(18.4));
    // Preview GIF: the reconnect story (problem -> Pult -> continues), 13 s, 960 px, 15 fps.
    const pal = path.join(TMP, 'palette.png');
    const flt = 'fps=15,scale=960:-1:flags=lanczos';
    ffmpeg(['-ss', '6.6', '-t', '13', '-i', mp4, '-vf', `${flt},palettegen=max_colors=96:stats_mode=diff`, pal]);
    ffmpeg(['-ss', '6.6', '-t', '13', '-i', mp4, '-i', pal, '-lavfi', `${flt}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, path.join(OUT, 'preview.gif')]);
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
