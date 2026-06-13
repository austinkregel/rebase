import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

// Calm, monospace-forward dark identity. The editor is the signature;
// everything around it stays quiet.
const colors = {
  bg: '#0d1117',
  fg: '#d4dae2',
  gutter: '#566069',
  selection: '#1f3a5f',
  activeLine: '#141b24',
  cursor: '#7aa2f7',
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
      backgroundColor: '#161d27',
      border: '1px solid #232b36',
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
