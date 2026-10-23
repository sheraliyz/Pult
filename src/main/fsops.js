'use strict';

// Server-side file operations: copy / move, archives, search, properties.
// They run as shell commands on the server (cp, mv, tar, zip, find, grep…),
// so a 2 GB folder is copied in place instead of through the phone or PC.

const posix = require('path').posix;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

const HOUR = 60 * 60 * 1000;

async function namesIn(sftp, dir) {
  const list = await call((cb) => sftp.readdir(dir, cb));
  return new Set(list.map((e) => e.filename));
}

// "report.pdf" → "report (1).pdf"; keeps double extensions like .tar.gz.
function uniqueName(taken, name, isDir) {
  if (!taken.has(name)) return name;
  let stem = name;
  let ext = '';
  const m = !isDir && name.match(/^(.+?)((?:\.tar)?\.[^./]{1,8})$/);
  if (m) {
    stem = m[1];
    ext = m[2];
  }
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function run(conn, script, timeout) {
  const r = await conn.exec(script, timeout);
  if (r.code !== 0) {
    const msg = `${r.stderr || ''}\n${r.stdout || ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' · ');
    const err = new Error(msg || 'Server buyrug‘i bajarilmadi');
    err.code = r.code === 127 ? 'NO_TOOL' : 'EXEC_FAILED';
    throw err;
  }
  return r.stdout;
}

/** Copy or move items into destDir. Name clashes get " (1)" etc. — never overwrite. */
async function copyItems(conn, items, destDir, { move = false } = {}) {
  const sftp = await conn.sftp();
  const taken = await namesIn(sftp, destDir);
  const cmds = [];
  for (const it of items) {
    const base = posix.basename(it.path);
    if (it.type === 'dir' && (destDir === it.path || destDir.startsWith(`${it.path}/`))) {
      throw new Error(`“${base}” papkasini o‘z ichiga ${move ? 'ko‘chirib' : 'nusxalab'} bo‘lmaydi`);
    }
    if (move && posix.dirname(it.path) === destDir) continue; // already here
    const name = uniqueName(taken, base, it.type === 'dir');
    taken.add(name);
    const target = posix.join(destDir, name);
    cmds.push(`${move ? 'mv' : 'cp -a'} -- ${shq(it.path)} ${shq(target)}`);
  }
  if (!cmds.length) return 0;
  try {
    await run(conn, cmds.join(' && '), 2 * HOUR);
  } catch (err) {
    // No shell on the server (e.g. Windows OpenSSH): moving still works over SFTP.
    if (!move || err.code !== 'NO_TOOL') throw err;
    for (const it of items) await call((cb) => sftp.rename(it.path, posix.join(destDir, posix.basename(it.path)), cb));
  }
  return cmds.length;
}

/** Pack names (inside cwd) into a .zip or .tar.gz in cwd. Returns the archive name. */
async function compress(conn, cwd, names, archiveName, format) {
  const sftp = await conn.sftp();
  const taken = await namesIn(sftp, cwd);
  const ext = format === 'zip' ? '.zip' : '.tar.gz';
  let name = archiveName.trim().replace(/\/+/g, '-') || 'arxiv';
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  name = uniqueName(taken, name, false);
  const list = names.map(shq).join(' ');
  const script =
    format === 'zip'
      ? `cd -- ${shq(cwd)} && if command -v zip >/dev/null 2>&1; then zip -rqy -- ${shq(name)} ${list}; ` +
        `elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -c ${shq(name)} ${list}; ` +
        `else echo "Serverda zip yo‘q — .tar.gz tanlang" >&2; exit 3; fi`
      : `tar -czf ${shq(posix.join(cwd, name))} -C ${shq(cwd)} -- ${list}`;
  await run(conn, script, 4 * HOUR);
  return name;
}

const ARCHIVE_RE = /(\.tar\.(?:gz|bz2|xz|zst|lz4)|\.tgz|\.tbz2?|\.txz|\.tar|\.zip|\.7z|\.rar|\.gz|\.bz2|\.xz|\.zst)$/i;

function isArchive(name) {
  return ARCHIVE_RE.test(name);
}

/** Extract an archive next to it ('here') or into a new folder named after it ('folder'). */
async function extract(conn, filePath, mode) {
  const sftp = await conn.sftp();
  const dir = posix.dirname(filePath);
  const base = posix.basename(filePath);
  const m = base.match(ARCHIVE_RE);
  if (!m) throw new Error('Bu arxiv turi qo‘llab-quvvatlanmaydi');
  const ext = m[1].toLowerCase();
  const stem = base.slice(0, base.length - m[1].length) || base;
  const taken = await namesIn(sftp, dir);
  const f = shq(filePath);

  // Single compressed files (.gz, .xz …) become one file next to the archive.
  const single = { '.gz': 'gzip', '.bz2': 'bzip2', '.xz': 'xz', '.zst': 'zstd' }[ext];
  if (single) {
    const out = posix.join(dir, uniqueName(taken, stem, false));
    await run(conn, `${single} -dc -- ${f} > ${shq(out)}`, 4 * HOUR);
    return posix.basename(out);
  }

  const dest = mode === 'folder' ? posix.join(dir, uniqueName(taken, stem, true)) : dir;
  const d = shq(dest);
  let cmd;
  if (/^\.(tar(\..+)?|tgz|tbz2?|txz)$/.test(ext)) cmd = `tar -xf ${f} -C ${d}`;
  else if (ext === '.zip') {
    cmd =
      `if command -v unzip >/dev/null 2>&1; then unzip -oq ${f} -d ${d}; ` +
      `elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e ${f} ${d}; ` +
      `elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf ${f} -C ${d}; ` +
      `else echo "Serverda unzip yo‘q (sudo apt install unzip)" >&2; exit 3; fi`;
  } else if (ext === '.7z') cmd = `7z x -y ${shq(`-o${dest}`)} ${f} >/dev/null`;
  else cmd = `unrar x -o+ ${f} ${shq(`${dest}/`)} >/dev/null`;
  await run(conn, `mkdir -p -- ${d} && ${cmd}`, 4 * HOUR);
  return mode === 'folder' ? posix.basename(dest) : null;
}

/** Recursive search below dir: by file name, or by text inside files. */
async function search(conn, dir, query, mode) {
  const d = shq(dir);
  const prune = `\\( -name .git -o -name node_modules -o -name .cache \\) -prune -o`;
  if (mode === 'name') {
    const glob = shq(`*${query.replace(/[\\*?[\]]/g, '\\$&')}*`);
    const out = await run(
      conn,
      `{ find ${d} -xdev ${prune} -iname ${glob} -printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null || find ${d} -xdev ${prune} -iname ${glob} -print 2>/dev/null; } | head -n 300; true`,
      60000,
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const p = line.split('\t');
        if (p.length < 4) return { path: line, type: 'file' };
        return { path: p.slice(3).join('\t'), type: p[0] === 'd' ? 'dir' : p[0] === 'l' ? 'link' : 'file', size: Number(p[1]), mtime: Math.floor(Number(p[2])) };
      })
      .filter((r) => r.path !== dir);
  }
  const q = shq(query);
  const out = await run(
    conn,
    `{ grep -rIinHZ --exclude-dir=.git --exclude-dir=node_modules -m 3 -F -e ${q} -- ${d} 2>/dev/null || ` +
      `grep -rIinH -m 3 -F -e ${q} -- ${d} 2>/dev/null; } | head -n 400; true`,
    60000,
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      let path;
      let rest;
      const z = line.indexOf('\0');
      if (z >= 0) {
        path = line.slice(0, z);
        rest = line.slice(z + 1);
      } else {
        const m = line.match(/^(.*?):(\d+):/);
        if (!m) return null;
        path = m[1];
        rest = line.slice(m[1].length + 1);
      }
      const m2 = rest.match(/^(\d+):(.*)$/);
      if (!m2) return null;
      return { path, type: 'file', line: Number(m2[1]), text: m2[2].trim().slice(0, 300) };
    })
    .filter(Boolean);
}

/** Details for the properties dialog. */
async function info(conn, p) {
  const P = shq(p);
  const out = await run(
    conn,
    `stat -c '%F|%s|%U|%G|%a|%Y' -- ${P} 2>/dev/null; echo '---'; file -b --mime-type -- ${P} 2>/dev/null; echo '---'; readlink -f -- ${P} 2>/dev/null; true`,
    15000,
  );
  const [statLine = '', mime = '', real = ''] = out.split('---\n').map((s) => s.trim());
  const [kind, size, owner, group, mode, mtime] = statLine.split('|');
  return {
    kind: kind || null,
    size: size ? Number(size) : null,
    owner: owner || null,
    group: group || null,
    mode: mode ? parseInt(mode, 8) : null,
    mtime: mtime ? Number(mtime) : null,
    mime: mime || null,
    real: real || null,
  };
}

/** Folder size and counts (can take a while on big trees). */
async function dirSize(conn, p) {
  const P = shq(p);
  // Labelled lines: a missing tool (no du on tiny systems) must not shift the others.
  const out = await run(
    conn,
    `echo "B $({ du -sb -- ${P} 2>/dev/null || du -sk -- ${P} 2>/dev/null | awk '{print $1*1024}'; } | cut -f1)"; ` +
      `echo "F $(find ${P} -xdev -type f 2>/dev/null | wc -l)"; echo "D $(find ${P} -xdev -mindepth 1 -type d 2>/dev/null | wc -l)"; true`,
    5 * 60000,
  );
  const val = (k) => {
    const m = out.match(new RegExp(`^${k} *(\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { bytes: val('B'), files: val('F') || 0, dirs: val('D') || 0 };
}

module.exports = { copyItems, compress, extract, isArchive, search, info, dirSize, uniqueName };
