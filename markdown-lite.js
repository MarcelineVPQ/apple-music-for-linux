// A small Markdown reader for Sonata's own texts (CHANGELOG.md sections in About → What's new):
// headings, paragraphs, bullet lists, **bold**, *italic*, `code` and [links](https://…). Pure: text in,
// a tree out. panel-ui.js builds DOM nodes from the tree (textContent only, never HTML strings), so
// nothing in a text can inject markup. Links keep only http(s) targets; anything else stays plain text.
;(function (root) {
  'use strict'

  // loop: HOT-PATH-OK — one pass over one line's characters; About is drawn on demand only
  function inline(src) {
    const out = []
    let s = String(src || '')
    let text = ''
    const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = '' } }
    while (s.length) {
      let m
      if ((m = /^\*\*([^*]+?)\*\*/.exec(s)) || (m = /^__([^_]+?)__/.exec(s))) { flush(); out.push({ t: 'b', c: inline(m[1]) }) }
      else if ((m = /^\*([^*\s][^*]*?)\*/.exec(s)) || (m = /^_([^_\s][^_]*?)_(?![A-Za-z0-9])/.exec(s))) { flush(); out.push({ t: 'i', c: inline(m[1]) }) }
      else if ((m = /^`([^`]+)`/.exec(s))) { flush(); out.push({ t: 'code', v: m[1] }) }
      else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s))) {
        flush()
        if (/^https?:\/\//i.test(m[2])) out.push({ t: 'a', href: m[2], c: inline(m[1]) })
        else out.push(...inline(m[1]))
      } else if ((m = /^<(https?:\/\/[^>\s]+)>/.exec(s))) { flush(); out.push({ t: 'a', href: m[1], c: [{ t: 'text', v: m[1] }] }) }
      else { text += s[0]; s = s.slice(1); continue }
      s = s.slice(m[0].length)
    }
    flush()
    return out
  }

  // -> [{ t: 'h', level, c } | { t: 'p', c } | { t: 'ul', items: [c] }]
  function parse(md) {
    const blocks = []
    let para = null
    let list = null
    const end = () => {
      if (para) { blocks.push({ t: 'p', c: inline(para.join(' ')) }); para = null }
      if (list) { blocks.push({ t: 'ul', items: list.map(inline) }); list = null }
    }
    // loop: NOT-WORTH — one pass over a section's lines (~10-60)
    for (const raw of String(md || '').split('\n')) {
      const line = raw.replace(/\s+$/, '')
      let m
      if (!line.trim() || /^<!--/.test(line.trim())) { end(); continue }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { end(); blocks.push({ t: 'h', level: m[1].length, c: inline(m[2]) }); continue }
      if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
        if (para) end()
        if (!list) list = []
        list.push(m[1])
        continue
      }
      if (list && /^\s{2,}\S/.test(line)) { list[list.length - 1] += ' ' + line.trim(); continue }
      if (list) end()
      if (!para) para = []
      para.push(line.trim())
    }
    end()
    return blocks
  }

  // the plain words of an inline tree (tests, tooltips)
  const plain = (c) => (c || []).map((n) => (n.t === 'text' || n.t === 'code' ? n.v : plain(n.c))).join('')

  const api = { parse, inline, plain }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataMarkdown = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
