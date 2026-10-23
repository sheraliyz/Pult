// Code editor for remote files: CodeMirror 6 with syntax colours, search &
// replace, go-to-line, undo/redo, bracket matching and folding.

import * as CM from './vendor/codemirror.js';
import { call } from './api.js';
import { h, icon, posix } from './dom.js';
import { toast, confirmDialog } from './ui.js';

function detectIndent(text) {
  let tabs = 0;
  const widths = {};
  for (const line of text.split('\n', 2000)) {
    if (line.startsWith('\t')) tabs += 1;
    const m = line.match(/^( +)\S/);
    if (m) widths[m[1].length] = (widths[m[1].length] || 0) + 1;
  }
  const spaces = Object.values(widths).reduce((a, b) => a + b, 0);
  if (tabs >= spaces) return '\t';
  const w = [2, 4, 8].find((n) => widths[n]) || 2;
  return ' '.repeat(w);
}

/* ---------------- languages ---------------- */

const legacy = (mode) => () => CM.StreamLanguage.define(mode);
const LANGS = [
  [/\.(m?jsx?|cjs)$/, 'JavaScript', () => CM.javascript({ jsx: true })],
  [/\.tsx?$/, 'TypeScript', () => CM.javascript({ typescript: true, jsx: true })],
  [/\.(json|jsonc|json5|lock)$/, 'JSON', () => CM.json()],
  [/\.(py|pyw)$/, 'Python', () => CM.python()],
  [/\.(s?css|less|sass)$/, 'CSS', () => CM.css()],
  [/\.(html?|vue|svelte)$/, 'HTML', () => CM.html()],
  [/\.(md|markdown|mdx)$/, 'Markdown', () => CM.markdown()],
  [/\.sql$/, 'SQL', () => CM.sql()],
  [/\.(xml|svg|plist|xsd|xsl)$/, 'XML', () => CM.xml()],
  [/\.(ya?ml)$|^docker-compose/, 'YAML', () => CM.yaml()],
  [/\.php$/, 'PHP', () => CM.php()],
  [/\.(c|h|cc|cpp|hpp|cxx|ino)$/, 'C/C++', () => CM.cpp()],
  [/\.(java|kt|kts|scala)$/, 'Java', () => CM.java()],
  [/\.go$/, 'Go', () => CM.go()],
  [/\.rs$/, 'Rust', () => CM.rust()],
  [/\.(sh|bash|zsh|ksh)$|^\.(bashrc|zshrc|profile|bash_profile|bash_aliases)$/, 'Shell', legacy(CM.shell)],
  [/nginx.*\.conf$|^nginx\.conf$|\/sites-(available|enabled)\//, 'Nginx', legacy(CM.nginx)],
  [/^dockerfile|\.dockerfile$/, 'Dockerfile', legacy(CM.dockerFile)],
  [/\.toml$/, 'TOML', legacy(CM.toml)],
  [/\.(ini|cfg|conf|properties|env|service|timer|socket)$|^\.env/, 'INI', legacy(CM.properties)],
  [/\.lua$/, 'Lua', legacy(CM.lua)],
  [/\.(diff|patch)$/, 'Diff', legacy(CM.diff)],
  [/\.ps1$/, 'PowerShell', legacy(CM.powerShell)],
];

function languageFor(path, text) {
  const name = posix.basename(path).toLowerCase();
  for (const [re, label, make] of LANGS) {
    if (re.test(name) || re.test(path)) return { label, ext: make() };
  }
  if (/^#!.*\b(ba|z|k)?sh\b/.test(text)) return { label: 'Shell', ext: legacy(CM.shell)() };
  if (/^#!.*python/.test(text)) return { label: 'Python', ext: CM.python() };
  if (/^#!.*node/.test(text)) return { label: 'JavaScript', ext: CM.javascript() };
  return { label: 'Matn', ext: [] };
}

/* ---------------- look ---------------- */

const t = CM.tags;
const highlight = CM.HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--syn-property)' },
  { tag: [t.definition(t.variableName), t.variableName], color: 'var(--syn-variable)' },
  { tag: [t.tagName, t.heading], color: 'var(--syn-tag)', fontWeight: '600' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--syn-punct)' },
  { tag: t.link, color: 'var(--syn-string)', textDecoration: 'underline' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--err)' },
]);

const theme = CM.EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', fontVariantLigatures: 'none' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '12px 0 40vh' },
  '.cm-line': { padding: '0 18px 0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--syn-selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-3)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '40px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 6px 0 0', color: 'var(--fg-3)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--active)', outline: '1px solid var(--line-2)', color: 'inherit' },
  '.cm-selectionMatch': { backgroundColor: 'var(--syn-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--syn-search)', outline: '1px solid var(--syn-search-border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--syn-search-border)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--active)', border: 'none', color: 'var(--fg-2)', padding: '0 6px', borderRadius: '4px' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-2)', border: '1px solid var(--line-2)', borderRadius: '8px', color: 'var(--fg)' },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--fg)', borderColor: 'var(--line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
});

// Uzbek labels for the built-in search / go-to-line panels.
const UZ = CM.EditorState.phrases.of({
  Find: 'Qidirish',
  Replace: 'Almashtirish',
  next: 'keyingi',
  previous: 'oldingi',
  all: 'hammasi',
  'match case': 'katta-kichik harf',
  'by word': 'butun so‘z',
  regexp: 'regexp',
  replace: 'almashtirish',
  'replace all': 'hammasini almashtirish',
  close: 'yopish',
  'current match': 'joriy',
  'replaced $ matches': '$ ta almashtirildi',
  'replaced match on line $': '$-qatorda almashtirildi',
  'on line': 'qatorda',
  'Go to line': 'Qatorga o‘tish',
  go: 'o‘tish',
  'Fold line': 'Yig‘ish',
  'Unfold line': 'Yoyish',
  'folded code': 'yig‘ilgan kod',
  unfold: 'yoyish',
});

/* ---------------- editor ---------------- */

export function openEditor(session, path, text, onSaved, { line } = {}) {
  const crlf = text.includes('\r\n');
  const original = crlf ? text.replace(/\r\n/g, '\n') : text;
  const indent = detectIndent(original);
  const lang = languageFor(path, original);
  let saved = original;
  let saving = false;
  let view;
  const wrap = new CM.Compartment();
  let wrapping = false;

  const pos = h('span', { class: 'e-pos' });
  const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => save() }, 'Saqlash', h('kbd', null, 'Ctrl S'));
  const wrapBtn = h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Qatorlarni o‘rash · Alt+Z', onclick: () => toggleWrap() }, icon('enter', 15));

  const isDirty = () => view.state.doc.toString() !== saved;
  const renderStatus = () => {
    const sel = view.state.selection.main;
    const ln = view.state.doc.lineAt(sel.head);
    const selected = sel.empty ? '' : ` (${sel.to - sel.from} belgi)`;
    pos.textContent = `${ln.number}:${sel.head - ln.from + 1}${selected}`;
    el.classList.toggle('dirty', isDirty());
  };

  function toggleWrap() {
    wrapping = !wrapping;
    view.dispatch({ effects: wrap.reconfigure(wrapping ? CM.EditorView.lineWrapping : []) });
    wrapBtn.classList.toggle('on', wrapping);
    view.focus();
    return true;
  }

  async function save() {
    if (saving) return true;
    saving = true;
    saveBtn.disabled = true;
    const value = view.state.doc.toString();
    try {
      await call('sftp:writeText', session.id, path, crlf ? value.replace(/\n/g, '\r\n') : value);
      saved = value;
      renderStatus();
      toast('Saqlandi', 'ok', 1400);
      onSaved?.();
    } catch (err) {
      toast(`Saqlab bo‘lmadi: ${err.message}`, 'err', 4000);
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
    return true;
  }

  async function close() {
    if (isDirty()) {
      const ok = await confirmDialog({
        title: 'Saqlanmagan o‘zgarishlar',
        message: `“${posix.basename(path)}” dagi o‘zgarishlar yo‘qoladi. Baribir yopilsinmi?`,
        confirm: 'Yopish',
        danger: true,
      });
      if (!ok) {
        view.focus();
        return;
      }
    }
    el.classList.add('out');
    setTimeout(() => {
      view.destroy();
      el.remove();
    }, 140);
    session.editor = null;
    session.focusActive();
  }

  const host = h('div', { class: 'e-body' });
  const dir = posix.dirname(path);
  const el = h(
    'div',
    { class: 'editor' },
    h(
      'div',
      { class: 'e-head' },
      h('span', { class: 'e-ic' }, icon('file', 16)),
      h('div', { class: 'e-path' }, h('span', { class: 'e-dir' }, dir === '/' ? '/' : `${dir}/`), h('span', { class: 'e-name' }, posix.basename(path))),
      h('span', { class: 'e-dirty', 'data-tip': 'Saqlanmagan o‘zgarishlar' }),
      h('div', { class: 'grow' }),
      h('span', { class: 'e-meta' }, lang.label),
      h('span', { class: 'e-meta' }, crlf ? 'CRLF' : 'LF'),
      h('span', { class: 'e-meta' }, indent === '\t' ? 'Tab' : `${indent.length} bo‘shliq`),
      pos,
      h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Qidirish va almashtirish · Ctrl+F / Ctrl+H', onclick: () => CM.openSearchPanel(view) }, icon('search', 15)),
      h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Qatorga o‘tish · Ctrl+G', onclick: () => CM.gotoLine(view) }, icon('arrowDown', 15)),
      wrapBtn,
      saveBtn,
      h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Yopish (Esc)', onclick: () => close() }, icon('x', 16)),
    ),
    host,
  );

  const state = CM.EditorState.create({
    doc: original,
    extensions: [
      UZ,
      CM.lineNumbers(),
      CM.highlightActiveLineGutter(),
      CM.highlightSpecialChars(),
      CM.history(),
      CM.foldGutter({ openText: '⌄', closedText: '›' }),
      CM.drawSelection(),
      CM.dropCursor(),
      CM.EditorState.allowMultipleSelections.of(true),
      CM.indentOnInput(),
      CM.syntaxHighlighting(highlight),
      CM.bracketMatching(),
      CM.closeBrackets(),
      CM.rectangularSelection(),
      CM.crosshairCursor(),
      CM.highlightActiveLine(),
      CM.highlightSelectionMatches(),
      CM.search({ top: true }),
      CM.indentUnit.of(indent),
      CM.EditorState.tabSize.of(indent === '\t' ? 4 : indent.length),
      wrap.of([]),
      CM.keymap.of([
        { key: 'Mod-s', run: () => (save(), true), preventDefault: true },
        { key: 'Mod-g', run: CM.gotoLine, preventDefault: true },
        { key: 'Mod-h', run: CM.openSearchPanel, preventDefault: true },
        { key: 'Alt-z', run: toggleWrap },
        ...CM.closeBracketsKeymap,
        ...CM.searchKeymap,
        ...CM.defaultKeymap,
        ...CM.historyKeymap,
        ...CM.foldKeymap,
        CM.indentWithTab,
        // Esc closes the editor once no panel is open (the search panel takes it first).
        { key: 'Escape', run: () => (close(), true) },
      ]),
      lang.ext,
      theme,
      CM.EditorView.updateListener.of((u) => {
        if (u.docChanged || u.selectionSet) renderStatus();
      }),
    ],
  });

  session.editor?.el.remove();
  session.editor = { el, close };
  session.el.append(el);
  view = new CM.EditorView({ state, parent: host });
  renderStatus();
  requestAnimationFrame(() => {
    if (line && line > 0 && line <= view.state.doc.lines) {
      const at = view.state.doc.line(line).from;
      view.dispatch({ selection: { anchor: at }, effects: CM.EditorView.scrollIntoView(at, { y: 'center' }) });
    }
    view.focus();
  });
}
