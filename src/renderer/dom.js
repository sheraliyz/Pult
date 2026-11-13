// Small DOM, icon and formatting helpers shared by every view.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'type') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/* ---------------- icons ---------------- */

const FOLDER = '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>';
const FILE = '<path d="M13.5 3.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5z"/><path d="M13.5 3.5v5h5"/>';

const PATHS = {
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  terminal: '<path d="M5.5 7.5l4.5 4.5-4.5 4.5"/><path d="M12.5 17h6"/>',
  folder: FOLDER,
  folderPlus: FOLDER + '<path d="M12 10.5v5M9.5 13h5"/>',
  file: FILE,
  filePlus: FILE + '<path d="M12 11.5v5M9.5 14h5"/>',
  split: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><path d="M10 5v14"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  sliders: '<path d="M4.5 8h9M17.5 8h2M4.5 16h2M10.5 16h9"/><circle cx="15.5" cy="8" r="2"/><circle cx="8.5" cy="16" r="2"/>',
  refresh: '<path d="M19 12.5A7 7 0 1 1 16.8 7"/><path d="M19.5 4.5v4h-4"/>',
  up: '<path d="M12 18.5v-13M7 10.5l5-5 5 5"/>',
  back: '<path d="M18.5 12h-13M10.5 7l-5 5 5 5"/>',
  upload: '<path d="M12 15V4.5M8 8.5l4-4 4 4"/><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4.5V15M8 11l4 4 4-4"/><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5l4 4"/>',
  trash: '<path d="M5 7.5h14M10 7.5V5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/><path d="M6.8 7.5l.8 10.7a2 2 0 0 0 2 1.8h4.8a2 2 0 0 0 2-1.8l.8-10.7"/>',
  pencil: '<path d="M14.5 6l3.5 3.5L9 18.5H5.5V15z"/><path d="M12.5 8l3.5 3.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  more: '<circle cx="6.5" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="17.5" cy="12" r="1.1" fill="currentColor"/>',
  chevron: '<path d="M10 7l5 5-5 5"/>',
  chevronDown: '<path d="M7 10l5 5 5-5"/>',
  check: '<path d="M5.5 12.5l4 4 9-9"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  key: '<circle cx="8.5" cy="15.5" r="3.5"/><path d="M11 13l7.5-7.5M15.5 8.5l2.5 2.5"/>',
  server: '<rect x="4" y="4.5" width="16" height="6.5" rx="1.8"/><rect x="4" y="13" width="16" height="6.5" rx="1.8"/><path d="M7.5 7.75h.01M7.5 16.25h.01"/>',
  alert: '<path d="M12 4.5l8 14.5H4z"/><path d="M12 10v3.5M12 16.2h.01"/>',
  shield: '<path d="M12 3.8l6.5 2.7v5c0 4.2-2.7 7.3-6.5 8.7-3.8-1.4-6.5-4.5-6.5-8.7v-5z"/>',
  eye: '<path d="M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 6.2A9.6 9.6 0 0 1 12 6c5.7 0 9 6 9 6a15.6 15.6 0 0 1-2.7 3.4M6.3 7.8C4.2 9.4 3 12 3 12s3.3 6 9 6a9 9 0 0 0 3.5-.7"/>',
  reveal: '<path d="M13.5 4.5h6v6M19.5 4.5L12 12"/><path d="M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10"/>',
  link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
  power: '<path d="M12 4v7"/><path d="M7.3 7.2a6.5 6.5 0 1 0 9.4 0"/>',
  enter: '<path d="M19 5.5v6a2.5 2.5 0 0 1-2.5 2.5H6"/><path d="M9.5 10.5L6 14l3.5 3.5"/>',
  arrowUp: '<path d="M12 18V6M7.5 10.5L12 6l4.5 4.5"/>',
  arrowDown: '<path d="M12 6v12M7.5 13.5L12 18l4.5-4.5"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  import: '<path d="M12 4.5v10M8 10.5l4 4 4-4"/><path d="M5 19.5h14"/>',
  logo: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M8.5 9.5l3 2.5-3 2.5"/><path d="M13 15h3"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.4L19 16M8.6 15.6L19 8"/>',
  paste: '<rect x="5.5" y="5" width="13" height="15.5" rx="2"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11.5h6M9 15h4"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  unarchive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M12 18.5v-6M9.5 15l2.5-2.5 2.5 2.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  duplicate: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/><path d="M14 11.5v5M11.5 14h5"/>',
  spark: '<path d="M10 4.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z"/><path d="M17 14l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/>',
  claude: '<path d="M12 4.5v15M4.5 12h15M6.7 6.7l10.6 10.6M17.3 6.7L6.7 17.3"/>',
  agy: '<path d="M12 4.5l6.5 14.5L12 15.5 5.5 19z"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  gauge: '<path d="M4.5 16.5a7.5 7.5 0 1 1 15 0"/><path d="M12 16.5l3.5-4.5"/>',
  resume: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M4.5 4.5v4h4"/><path d="M10.5 9.5l4 2.5-4 2.5z"/>',
};

const tpl = document.createElement('template');

export function icon(name, size = 16, cls = '') {
  tpl.innerHTML = `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  return tpl.content.firstChild;
}

/* ---------------- formatting (Uzbek) ---------------- */

const MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
const pad = (n) => String(n).padStart(2, '0');

export const fmt = {
  bytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = -1;
    do {
      v /= 1024;
      i += 1;
    } while (v >= 1024 && i < units.length - 1);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  },

  date(sec) {
    if (!sec) return '—';
    const d = new Date(sec * 1000);
    const now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `bugun, ${time}`;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `kecha, ${time}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  },

  ago(ms) {
    if (!ms) return 'hali ulanilmagan';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'hozirgina';
    if (s < 3600) return `${Math.floor(s / 60)} daqiqa oldin`;
    if (s < 86400) return `${Math.floor(s / 3600)} soat oldin`;
    if (s < 172800) return 'kecha';
    if (s < 2592000) return `${Math.floor(s / 86400)} kun oldin`;
    return fmt.date(ms / 1000);
  },

  uptime(sec) {
    if (!sec) return '—';
    const d = Math.floor(sec / 86400);
    if (d > 0) return `${d} kun`;
    const hrs = Math.floor(sec / 3600);
    if (hrs > 0) return `${hrs} soat`;
    return `${Math.max(1, Math.floor(sec / 60))} daq`;
  },

  mode(mode, type) {
    const t = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
    const bits = 'rwxrwxrwx';
    let out = t;
    for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-';
    return out;
  },

  octal(mode) {
    return (mode & 0o7777).toString(8).padStart(3, '0');
  },

  speed(bps) {
    return bps ? `${fmt.bytes(Math.round(bps))}/s` : '';
  },

  /** Time left until a moment: "2 soat 10 daq", "3 kun 4 soat", "40 daq". */
  until(ms) {
    const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    const d = Math.floor(s / 86400);
    const hrs = Math.floor((s % 86400) / 3600);
    const min = Math.floor((s % 3600) / 60);
    if (d > 0) return hrs ? `${d} kun ${hrs} soat` : `${d} kun`;
    if (hrs > 0) return min ? `${hrs} soat ${min} daq` : `${hrs} soat`;
    return `${Math.max(1, min)} daq`;
  },

  /** A moment in the near future: "14:30", "ertaga 09:00", "Pa 09:00", "18-noy 09:00". */
  when(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return time;
    const t = new Date(now);
    t.setDate(now.getDate() + 1);
    if (d.toDateString() === t.toDateString()) return `ertaga ${time}`;
    if (d - now < 6 * 86400e3 && d > now) return `${WEEKDAYS[d.getDay()]} ${time}`;
    return `${d.getDate()}-${MONTHS[d.getMonth()]} ${time}`;
  },
};

const WEEKDAYS = ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'];

export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export const posix = {
  join(...parts) {
    const joined = parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    return joined || '/';
  },
  dirname(p) {
    if (p === '/' || !p.includes('/')) return '/';
    const d = p.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
    return d || '/';
  },
  basename(p) {
    return p.replace(/\/+$/, '').split('/').pop() || '/';
  },
};

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
