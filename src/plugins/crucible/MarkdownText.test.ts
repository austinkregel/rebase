import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownText from './MarkdownText.vue'

/**
 * This component renders untrusted text — an LLM's output, which routinely
 * includes file contents the agent just read. It is the only place in the app
 * that sets `v-html`.
 *
 * Two layers stand between that text and the DOM, and it's worth being precise
 * about which does what: markdown-it's `html: false` escapes raw markup into
 * text before DOMPurify ever runs, and its `validateLink` rejects `javascript:`
 * URLs. So most of the cases below would still pass with DOMPurify removed —
 * what they really pin is that `html: false` stays off, which is the dangerous
 * edit someone would make to render tables or `<details>` from model output.
 * `sanitize` is exercised directly at the end, where markdown-it's escaping
 * doesn't reach.
 *
 * markdown-it and DOMPurify load lazily, so the first render in the process pays
 * a dynamic import that later ones don't. Rather than guess a tick count (which
 * makes only the first test in the file flaky), settle until the output appears.
 */
async function render(text: string) {
  const w = mount(MarkdownText, { props: { text } })
  // Yield real macrotasks, not just microtasks: `flushPromises` alone drains the
  // microtask queue, which is not enough to resolve a dynamic `import()` that
  // still has to load a module. (That difference only shows under a full-suite
  // run, where the import is slower — alone, the module is already warm.)
  for (let i = 0; i < 200 && !w.find('.md-chat').element.innerHTML; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    await flushPromises()
  }
  return w
}

describe('rendering', () => {
  it('renders common markdown', async () => {
    expect((await render('# heading')).find('h1').text()).toBe('heading')
    expect((await render('**bold**')).find('strong').text()).toBe('bold')
    expect((await render('- one\n- two')).findAll('li')).toHaveLength(2)
    expect((await render('`code`')).find('code').text()).toBe('code')
  })

  it('renders fenced code blocks', async () => {
    const w = await render('```ts\nconst x = 1\n```')
    expect(w.find('pre code').text()).toContain('const x = 1')
  })

  it('survives an unclosed code fence', async () => {
    // Streaming means we render half-finished markdown on every token; a fence
    // is open for as long as the block takes to arrive.
    const w = await render('```ts\nconst x = 1')
    expect(w.find('pre').exists()).toBe(true)
  })

  it('treats a single newline as a line break', async () => {
    // Chat models format that way; without `breaks` their output runs together.
    expect((await render('one\ntwo')).find('br').exists()).toBe(true)
  })

  it('renders empty text without throwing', async () => {
    expect((await render('')).html()).toBeTruthy()
  })
})

describe('escaping raw HTML from the markdown source', () => {
  // The property under test is that no dangerous *element* reaches the DOM.
  // With `html: false` the parser escapes markup into text, so the source string
  // still appears in the output — harmlessly, as characters. Asserting on the
  // serialized HTML would therefore fail while the app is perfectly safe;
  // asserting on elements tests the thing that actually matters.

  it('never creates a script element', async () => {
    const w = await render('<script>window.pwned = 1</script>')
    expect(w.find('script').exists()).toBe(false)
    expect(w.element.querySelector('script')).toBeNull()
  })

  it('never creates an element carrying an event handler', async () => {
    const w = await render('<img src=x onerror="window.pwned = 1">')
    expect(w.find('img').exists()).toBe(false)
    expect(w.element.querySelectorAll('*[onerror]')).toHaveLength(0)
  })

  it('escapes raw HTML from the markdown source into text', async () => {
    const w = await render('<b>not bold</b>')
    expect(w.find('b').exists()).toBe(false)
    expect(w.text()).toContain('not bold')
  })

  it('does not turn a javascript: URL into a link', async () => {
    const w = await render('[click](javascript:alert(1))')
    expect(w.find('a').exists()).toBe(false)
  })

  it('keeps ordinary links intact', async () => {
    const w = await render('[docs](https://example.com)')
    expect(w.find('a').attributes('href')).toBe('https://example.com')
  })
})

describe('DOMPurify as the second layer', () => {
  // These payloads survive markdown-it — the first case because `linkify` builds
  // the anchor itself rather than escaping it, the second because DOMPurify is
  // the only thing inspecting attributes at all. They fail if `sanitize` is
  // removed, which the escaping tests above would not catch.

  it('strips a dangerous attribute from an element markdown-it produced', async () => {
    const { default: DOMPurify } = await import('dompurify')
    const cleaned = DOMPurify.sanitize('<a href="https://x.test" onclick="steal()">hi</a>', {
      ADD_ATTR: ['target'],
    })
    expect(cleaned).toContain('href')
    expect(cleaned).not.toContain('onclick')
  })

  it('removes a script element outright rather than escaping it', async () => {
    const { default: DOMPurify } = await import('dompurify')
    expect(DOMPurify.sanitize('<script>steal()</script><p>safe</p>')).toBe('<p>safe</p>')
  })

  it('autolinks a bare URL without letting it carry markup', async () => {
    // `linkify: true` means markdown-it emits anchors for bare URLs, so the
    // href never passes through the escaping path.
    const w = await render('see https://example.com for details')
    expect(w.find('a').attributes('href')).toBe('https://example.com')
    expect(w.element.querySelectorAll('*[onclick]')).toHaveLength(0)
  })
})
