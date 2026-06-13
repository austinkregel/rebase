import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap'
import { rebaseTheme } from './theme'

// Compartments let us reconfigure language/theme/settings on the live view
// instead of recreating it (the old re-base editor-lifecycle trap).
export const languageCompartment = new Compartment()
export const themeCompartment = new Compartment()
export const settingsCompartment = new Compartment()

/** User-configurable editor features, persisted and tunable from the IDE tab. */
export interface EditorSettings {
  fontSize: number
  tabSize: number
  indentWithTabs: boolean
  lineWrapping: boolean
  lineNumbers: boolean
  highlightActiveLine: boolean
  bracketMatching: boolean
  closeBrackets: boolean
  autocomplete: boolean
  foldGutter: boolean
}

export const defaultEditorSettings: EditorSettings = {
  fontSize: 13,
  tabSize: 2,
  indentWithTabs: false,
  lineWrapping: false,
  lineNumbers: true,
  highlightActiveLine: true,
  bracketMatching: true,
  closeBrackets: true,
  autocomplete: true,
  foldGutter: true,
}

/** Build the toggle-able extensions from settings (held in settingsCompartment). */
export function settingsExtensions(s: EditorSettings): Extension {
  const exts: Extension[] = [
    EditorState.tabSize.of(s.tabSize),
    indentUnit.of(s.indentWithTabs ? '\t' : ' '.repeat(s.tabSize)),
    EditorView.theme({ '&': { fontSize: `${s.fontSize}px` } }),
  ]
  if (s.lineWrapping) exts.push(EditorView.lineWrapping)
  if (s.lineNumbers) exts.push(lineNumbers())
  if (s.foldGutter) exts.push(foldGutter())
  if (s.highlightActiveLine) exts.push(highlightActiveLine(), highlightActiveLineGutter())
  if (s.bracketMatching) exts.push(bracketMatching())
  if (s.closeBrackets) exts.push(closeBrackets())
  if (s.autocomplete) exts.push(autocompletion())
  return exts
}

/** Reconfigure a live view's settings without rebuilding it. */
export function reconfigureSettings(s: EditorSettings) {
  return settingsCompartment.reconfigure(settingsExtensions(s))
}

// Language packs load on demand so the app shell stays small — each becomes
// its own chunk, fetched (and service-worker cached) on first use.
export async function languageFor(path: string): Promise<Extension> {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript()
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
    case 'ts':
    case 'mts':
    case 'cts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true })
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })
    case 'json':
    case 'jsonc':
      return (await import('@codemirror/lang-json')).json()
    case 'css':
    case 'scss':
    case 'less':
      return (await import('@codemirror/lang-css')).css()
    case 'html':
    case 'htm':
      return (await import('@codemirror/lang-html')).html()
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown()
    case 'py':
      return (await import('@codemirror/lang-python')).python()
    case 'go':
      return (await import('@codemirror/lang-go')).go()
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust()
    case 'php':
      return (await import('@codemirror/lang-php')).php()
    case 'vue':
      return (await import('@codemirror/lang-vue')).vue()
    case 'yml':
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml()
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql()
    default:
      return []
  }
}

export interface CreateStateOptions {
  doc: string
  onChange?: (doc: string) => void
  onSave?: () => void
  settings?: EditorSettings
}

// Language starts empty; the editor reconfigures the compartment once the
// pack for the file's extension has loaded. Feature toggles live in
// settingsCompartment so the IDE settings can reconfigure them live.
export function createEditorState({
  doc,
  onChange,
  onSave,
  settings = defaultEditorSettings,
}: CreateStateOptions): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      highlightSelectionMatches(),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onSave?.()
            return true
          },
        },
        ...closeBracketsKeymap,
        // VS Code editor keybindings (multi-cursor, line move/copy, etc.) take
        // priority over the generic defaults below.
        ...vscodeKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange?.(update.state.doc.toString())
      }),
      settingsCompartment.of(settingsExtensions(settings)),
      languageCompartment.of([]),
      themeCompartment.of(rebaseTheme),
    ],
  })
}
