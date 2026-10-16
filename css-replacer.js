// Keep exactly one copy of our custom CSS in a page.
// webContents.insertCSS adds a NEW stylesheet on every call; main.js re-applies
// the CSS on every navigation and every page-title change, so without this the
// page collected one extra stylesheet per title change for as long as the app ran.
// Each insert removes the previous one once the new one is in (no unstyled flash).
// A key from a previous document is stale; removing it just fails quietly.
function createCssReplacer(webContents, css) {
  let key = null
  return function apply() {
    return webContents.insertCSS(css).then((next) => {
      const old = key
      key = next
      if (old) return webContents.removeInsertedCSS(old).catch(() => {})
    }).catch(() => {})
  }
}

module.exports = { createCssReplacer }
