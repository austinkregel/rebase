<script setup lang="ts">
import { ref, watch } from 'vue'
import type MarkdownIt from 'markdown-it'

// Inline markdown renderer for chat. The agent emits plain markdown; we render
// it to HTML and sanitize with DOMPurify before injecting (LLM output is
// untrusted — and we disable raw HTML in the source for good measure). Libs load
// lazily so they don't weigh on startup. Styling is compact to fit a chat bubble,
// unlike the full-page MarkdownViewer.
const props = defineProps<{ text: string }>()
const html = ref('')

let md: MarkdownIt | null = null
let sanitize: ((dirty: string) => string) | null = null

async function ensureLibs() {
  if (md && sanitize) return
  const [{ default: MarkdownItCtor }, { default: DOMPurify }] = await Promise.all([
    import('markdown-it'),
    import('dompurify'),
  ])
  // breaks: a single newline becomes <br> (chat models format that way).
  // html: false — never trust raw HTML embedded in model output.
  md = new MarkdownItCtor({ html: false, linkify: true, typographer: true, breaks: true })
  sanitize = (dirty) => DOMPurify.sanitize(dirty, { ADD_ATTR: ['target'] })
}

async function render() {
  await ensureLibs()
  html.value = sanitize!(md!.render(props.text ?? ''))
}

watch(() => props.text, render, { immediate: true })
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify above -->
  <div class="md-chat" v-html="html" />
</template>

<style scoped>
/* Compact prose for chat bubbles: tight rhythm, no outer margins so it sits
   flush in the bubble padding. Inherits font-size/color from the bubble. */
.md-chat :deep(> :first-child) {
  margin-top: 0;
}
.md-chat :deep(> :last-child) {
  margin-bottom: 0;
}
.md-chat :deep(p),
.md-chat :deep(ul),
.md-chat :deep(ol),
.md-chat :deep(blockquote),
.md-chat :deep(pre),
.md-chat :deep(table) {
  margin: 0.5em 0;
}
.md-chat :deep(h1),
.md-chat :deep(h2),
.md-chat :deep(h3),
.md-chat :deep(h4) {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
}
.md-chat :deep(h1) {
  font-size: 1.3em;
}
.md-chat :deep(h2) {
  font-size: 1.2em;
}
.md-chat :deep(h3) {
  font-size: 1.08em;
}
.md-chat :deep(ul),
.md-chat :deep(ol) {
  padding-left: 1.3em;
}
.md-chat :deep(li) {
  margin: 0.15em 0;
}
.md-chat :deep(li > p) {
  margin: 0.15em 0;
}
.md-chat :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.md-chat :deep(a:hover) {
  text-decoration: underline;
}
.md-chat :deep(code) {
  padding: 0.1em 0.35em;
  font-family: var(--font-mono, monospace);
  font-size: 0.85em;
  background: var(--surface);
  border-radius: 4px;
}
.md-chat :deep(pre) {
  padding: 10px 12px;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.md-chat :deep(pre code) {
  padding: 0;
  font-size: 0.85em;
  background: none;
}
.md-chat :deep(blockquote) {
  padding-left: 0.8em;
  color: var(--muted);
  border-left: 3px solid var(--line);
}
.md-chat :deep(table) {
  border-collapse: collapse;
}
.md-chat :deep(th),
.md-chat :deep(td) {
  padding: 4px 9px;
  border: 1px solid var(--line);
}
.md-chat :deep(img) {
  max-width: 100%;
}
.md-chat :deep(hr) {
  margin: 1em 0;
  border: none;
  border-top: 1px solid var(--line);
}
</style>
