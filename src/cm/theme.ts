import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

// Calm, monospace-forward dark identity. The editor is the signature;
// everything around it stays quiet.
//
// Structural colors (chrome, cursor, gutter) reference the runtime theme tokens
// via var(), so the editor follows the app theme/accent live. The syntax palette
// below stays fixed — that's the editor's deliberate identity, independent of the
// chrome theme.
const colors = {
  bg: 'var(--color-bg)',
  fg: 'var(--color-fg)',
  gutter: 'var(--color-subtle)',
  selection: '#1f3a5f',
  activeLine: 'var(--color-active)',
  cursor: 'var(--color-accent)',
  comment: '#5e6a76',
  keyword: '#bb9af7',
  string: '#9ece6a',
  number: '#ff9e64',
  fn: '#7aa2f7',
  type: '#2ac3de',
  property: '#73daca',
  invalid: '#f7768e',
}

const editorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: colors.bg,
      color: colors.fg,
      height: '100%',
      fontSize: '13px',
    },
    '.cm-content': {
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      caretColor: colors.cursor,
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: colors.cursor },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: colors.selection },
    '.cm-activeLine': { backgroundColor: colors.activeLine },
    '.cm-activeLineGutter': { backgroundColor: colors.activeLine, color: colors.fg },
    '.cm-gutters': {
      backgroundColor: colors.bg,
      color: colors.gutter,
      border: 'none',
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-matchingBracket': { backgroundColor: '#2a3950', outline: 'none' },
    '.cm-searchMatch': { backgroundColor: '#3b4261' },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-elevated)',
      border: '1px solid var(--color-line)',
      color: colors.fg,
    },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: colors.comment, fontStyle: 'italic' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.moduleKeyword], color: colors.keyword },
  { tag: [t.string, t.special(t.string), t.regexp], color: colors.string },
  { tag: [t.number, t.bool, t.null, t.atom], color: colors.number },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: colors.fn },
  { tag: [t.typeName, t.className, t.namespace], color: colors.type },
  { tag: [t.propertyName, t.attributeName], color: colors.property },
  { tag: [t.definition(t.variableName)], color: colors.fg },
  { tag: t.invalid, color: colors.invalid },
  { tag: [t.meta, t.punctuation], color: '#8b98a5' },
  { tag: t.heading, color: colors.fn, fontWeight: 'bold' },
  { tag: t.link, color: colors.type, textDecoration: 'underline' },
])

export const rebaseTheme: Extension = [editorTheme, syntaxHighlighting(highlight)]
