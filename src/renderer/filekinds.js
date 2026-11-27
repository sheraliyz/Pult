// What kind of file is this? The kind names the type in the badge's tooltip
// (the badge itself shows the extension). Same table as the Android app
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
