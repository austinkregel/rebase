<script setup lang="ts">
import { ref, watch } from 'vue'
import type MarkdownIt from 'markdown-it'

// Rendered-markdown viewer. The panel reads the file as text and passes it here;
// we render with markdown-it and sanitize the HTML with DOMPurify before
// injecting it (remote file content is untrusted). Both libs load lazily so they
// don't weigh on startup. The panel's "View Source" toggle edits the same buffer.
const props = defineProps<{ path: string; clientId: string; mime: string; content: string }>()
const html = ref('')

let md: MarkdownIt | null = null
let sanitize: ((dirty: string) => string) | null = null

async function ensureLibs() {
  if (md && sanitize) return
  const [{ default: MarkdownItCtor }, { default: DOMPurify }] = await Promise.all([
    import('markdown-it'),
    import('dompurify'),
  ])
  md = new MarkdownItCtor({ html: true, linkify: true, typographer: true })
  sanitize = (dirty) => DOMPurify.sanitize(dirty)
}

async function render() {
  await ensureLibs()
  html.value = sanitize!(md!.render(props.content ?? ''))
}

watch(() => props.content, render, { immediate: true })
</script>

<template>
  <div class="markdown-viewer">
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify above -->
    <article class="prose" v-html="html" />
  </div>
</template>

<style scoped>
.markdown-viewer {
  height: 100%;
  overflow: auto;
  background: var(--bg);
}
.prose {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 32px 64px;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.65;
}
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3),
.prose :deep(h4) {
  margin: 1.4em 0 0.6em;
  font-weight: 600;
  line-height: 1.25;
}
.prose :deep(h1) {
  font-size: 1.7em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--line);
}
.prose :deep(h2) {
  font-size: 1.35em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--line);
}
.prose :deep(h3) {
  font-size: 1.15em;
}
.prose :deep(p),
.prose :deep(ul),
.prose :deep(ol),
.prose :deep(blockquote),
.prose :deep(table) {
  margin: 0.7em 0;
}
.prose :deep(ul),
.prose :deep(ol) {
  padding-left: 1.5em;
}
.prose :deep(li) {
  margin: 0.25em 0;
}
.prose :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.prose :deep(a:hover) {
  text-decoration: underline;
}
.prose :deep(code) {
  padding: 0.15em 0.4em;
  font-family: var(--font-mono, monospace);
  font-size: 0.88em;
  background: var(--surface);
  border-radius: 4px;
}
.prose :deep(pre) {
  margin: 0.9em 0;
  padding: 14px 16px;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.prose :deep(pre code) {
  padding: 0;
  background: none;
}
.prose :deep(blockquote) {
  padding-left: 1em;
  color: var(--muted);
  border-left: 3px solid var(--line);
}
.prose :deep(table) {
  border-collapse: collapse;
}
.prose :deep(th),
.prose :deep(td) {
  padding: 6px 12px;
  border: 1px solid var(--line);
}
.prose :deep(img) {
  max-width: 100%;
}
.prose :deep(hr) {
  margin: 1.6em 0;
  border: none;
  border-top: 1px solid var(--line);
}
</style>
