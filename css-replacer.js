// Keep exactly one copy of our custom CSS in a page.
// webContents.insertCSS adds a NEW stylesheet on every call; main.js re-applies
// the CSS on every navigation and every page-title change, so without this the
// page collected one extra stylesheet per title change for as long as the app ran.
// Each insert removes the previous one once the new one is in (no unstyled flash).
// A key from a previous document is stale; removing it just fails quietly.
// `css` is a string, or a function returning the current CSS (read at every apply: the
// navigation rail's room changes with its pin and the window width).
function createCssReplacer(webContents, css) {
  let key = null
  return function apply() {
    const text = typeof css === 'function' ? css() : css
    return webContents.insertCSS(text).then((next) => {
      const old = key
      key = next
      // error: NOT-WORTH — a key from a previous document is stale; removing it fails and there is nothing to remove
      if (old) return webContents.removeInsertedCSS(old).catch(() => {})
      // error: NOT-WORTH — insertCSS fails only while the page is mid-navigation; the next navigation or title change applies it again
    }).catch(() => {})
  }
}

module.exports = { createCssReplacer }
