// What kind of file is this? Icon + colour per type, so folders, APKs,
// EXEs, archives… are told apart at a glance. Same table as the Android app
// (mobile/lib/ui/file_kinds.dart).

const groups = {
  apk: 'apk aab xapk apks',
  exe: 'exe msi msix appx dll bat cmd ps1 com',
  package: 'deb rpm appimage snap flatpak pkg dmg ipa',
  archive: 'zip tar gz tgz bz2 tbz2 xz txz 7z rar zst lz4 lzma z cab iso img',
  image: 'png jpg jpeg gif webp svg ico bmp tif tiff heic avif psd',
  video: 'mp4 mkv mov avi webm flv wmv m4v 3gp',
  audio: 'mp3 wav flac ogg m4a aac opus wma',
  code: 'js mjs cjs jsx ts tsx py go rs java kt kts c h cpp hpp cc cs php rb dart swift lua pl r scala vue svelte',
  script: 'sh bash zsh fish',
  web: 'html htm css scss sass less',
  config: 'json yml yaml toml ini conf cfg env xml properties lock plist service timer socket',
  text: 'txt md rst',
  pdf: 'pdf',
  doc: 'doc docx odt rtf',
  table: 'csv tsv xls xlsx ods',
  db: 'sql db sqlite sqlite3 dump',
  key: 'pem key crt cer csr pub p12 pfx jks gpg asc',
  log: 'log',
  font: 'ttf otf woff woff2',
};

const BY_EXT = {};
for (const [kind, exts] of Object.entries(groups)) for (const e of exts.split(' ')) BY_EXT[e] = kind;

const BY_NAME = {
  dockerfile: 'config', makefile: 'config', jenkinsfile: 'config', vagrantfile: 'config', procfile: 'config',
  '.bashrc': 'config', '.zshrc': 'config', '.profile': 'config', '.bash_profile': 'config',
  '.gitignore': 'config', '.dockerignore': 'config', '.editorconfig': 'config',
  authorized_keys: 'key', known_hosts: 'key', id_rsa: 'key', id_ed25519: 'key', id_ecdsa: 'key',
  readme: 'text', license: 'text', changelog: 'text',
};

export function kindOf(e) {
  if (e.type === 'dir' || (e.type === 'link' && e.target === 'dir')) return 'folder';
  const name = e.name.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('.env')) return 'config';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && BY_EXT[name.slice(dot + 1)]) return BY_EXT[name.slice(dot + 1)];
  if (/\.log(\.\d+)?$/.test(name)) return 'log'; // rotated logs: app.log.1
  if (e.mode & 0o111) return 'script'; // executable bit
  return 'file';
}

export const KIND_LABEL = {
  folder: 'Papka', apk: 'Android ilova', exe: 'Windows dastur', package: 'O‘rnatish paketi', archive: 'Arxiv',
  image: 'Rasm', video: 'Video', audio: 'Audio', code: 'Kod', script: 'Skript', web: 'Veb', config: 'Sozlama',
  text: 'Matn', pdf: 'PDF', doc: 'Hujjat', table: 'Jadval', db: 'Ma’lumotlar bazasi', key: 'Kalit', log: 'Log',
  font: 'Shrift', file: 'Fayl',
};

// 24×24 stroke icons (stroke = currentColor, 1.6).
const FOLDER = '<path class="fill" d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>';
const SHEET = '<path d="M13.5 3.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5z"/><path d="M13.5 3.5v5h5"/>';

export const KIND_SVG = {
  folder: FOLDER,
  apk: '<path class="fill" d="M4 16.5a8 8 0 0 1 16 0V18H4z"/><path d="M8 9.6L6.3 6.6M16 9.6l1.7-3"/><circle cx="9" cy="13.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="13.6" r="1.1" fill="currentColor" stroke="none"/>',
  exe: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><path d="M3.5 9h17"/><path d="M6.4 7h.01M8.6 7h.01"/>',
  package: '<path d="M12 3.6l7.5 4.2v8.4L12 20.4l-7.5-4.2V7.8z"/><path d="M4.5 7.8L12 12l7.5-4.2M12 12v8.4"/>',
  archive: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.2"/><path d="M11 3.5v2h2v2h-2v2h2v2h-2"/><rect x="10" y="13.5" width="4" height="4" rx="1"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="9.6" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8.6 8.5"/>',
  video: '<rect x="3.5" y="5.5" width="12.5" height="13" rx="2.2"/><path d="M16 10l4.5-2.6v9.2L16 14"/>',
  audio: '<path d="M9 17.5V6.3l10-2.1v11"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.2" r="2.5"/>',
  code: '<path d="M8.5 8l-4 4 4 4M15.5 8l4 4-4 4"/><path d="M13.6 5.5l-3.2 13"/>',
  script: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4"/>',
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.4 5.6 3.4 8.5s-1 5.9-3.4 8.5c-2.4-2.6-3.4-5.6-3.4-8.5s1-5.9 3.4-8.5z"/>',
  config: '<path d="M4.5 8h9M17.5 8h2M4.5 16h2M10.5 16h9"/><circle cx="15.5" cy="8" r="2"/><circle cx="8.5" cy="16" r="2"/>',
  text: SHEET + '<path d="M8.6 12.5h6.8M8.6 15.5h6.8"/>',
  pdf: SHEET + '<path d="M8.5 15.5h7M8.5 12.5h4"/>',
  doc: SHEET + '<path d="M8.6 12h6.8M8.6 14.8h6.8M8.6 17.6h4"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  db: '<ellipse cx="12" cy="6.2" rx="7" ry="2.7"/><path d="M5 6.2v11.6c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6.2"/><path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7"/>',
  key: '<circle cx="8.5" cy="15.5" r="3.5"/><path d="M11 13l7.5-7.5M15.5 8.5l2.5 2.5"/>',
  log: '<path d="M8.5 7h11M8.5 12h11M8.5 17h11"/><path d="M4.6 7h.01M4.6 12h.01M4.6 17h.01"/>',
  font: '<path d="M5.5 19l5.3-14h2.4l5.3 14"/><path d="M7.8 13.5h8.4"/>',
  file: SHEET,
};

const tpl = document.createElement('template');

export function kindIcon(kind, size = 16) {
  tpl.innerHTML = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_SVG[kind] || KIND_SVG.file}</svg>`;
  return tpl.content.firstChild;
}
