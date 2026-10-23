// Everything the desktop editor needs from CodeMirror 6, bundled into one
// ES module (src/renderer/vendor/codemirror.js):  npm install && npm run build

export { EditorState, Compartment } from '@codemirror/state';
export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine, search } from '@codemirror/search';
export {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  StreamLanguage,
  indentUnit,
} from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { tags } from '@lezer/highlight';

export { javascript } from '@codemirror/lang-javascript';
export { json } from '@codemirror/lang-json';
export { python } from '@codemirror/lang-python';
export { css } from '@codemirror/lang-css';
export { html } from '@codemirror/lang-html';
export { markdown } from '@codemirror/lang-markdown';
export { sql } from '@codemirror/lang-sql';
export { xml } from '@codemirror/lang-xml';
export { yaml } from '@codemirror/lang-yaml';
export { php } from '@codemirror/lang-php';
export { cpp } from '@codemirror/lang-cpp';
export { java } from '@codemirror/lang-java';
export { go } from '@codemirror/lang-go';
export { rust } from '@codemirror/lang-rust';

export { shell } from '@codemirror/legacy-modes/mode/shell';
export { nginx } from '@codemirror/legacy-modes/mode/nginx';
export { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
export { toml } from '@codemirror/legacy-modes/mode/toml';
export { properties } from '@codemirror/legacy-modes/mode/properties';
export { lua } from '@codemirror/legacy-modes/mode/lua';
export { diff } from '@codemirror/legacy-modes/mode/diff';
export { powerShell } from '@codemirror/legacy-modes/mode/powershell';
