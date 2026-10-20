// Sonata's one task registry (pure: no DOM, no Electron; Marcy 2026-10-19: "the whole app works the same
// way for all things"). Anything that needs the user's attention registers a task here, and only here:
//   id       who it is ('helper', 'notice:update', …); set again to change it, clear when resolved or seen
//   page     the panel page it lives on ('settings' | 'about'): the rail item that shows the dot
//   section  the section it is about (panel-model.js ids), or '' for the page as a whole
//   level    'task' (something to do: an update, a repair) or 'error' (something went wrong)
//   text     what is waiting, in words: the rail item's tooltip, the section header's status and the
//            screen reader's "Waiting: …" (never colour alone)
// What reads it: the rail (a dot on the page's item while that page isn't shown, rail-model.js), the side
// panel (a dot on the section's header, panel-ui.js), and a press on the rail item, which opens the page
// at the first waiting section, expanded (main.js togglePanelPage). One look everywhere: the .task dot
// in theme.css (the --s-warn token). Notices with task: true, and error notices, register themselves
// (notices-model.js); states that have no notice (the Precise timing helper needs an update or a repair:
// helper-install-model.js taskOf) register directly. Nothing else may draw its own badge or dot
// (test/tasks.test.js).
;(function (root) {
  'use strict'
  const PAGES = ['settings', 'about']
  const LEVELS = ['task', 'error']

  function createTasks(opts) {
    const onChange = (opts && opts.onChange) || (() => {})
    // one entry per id (≤ ~12 ids in main.js), each set and cleared by its owner
    let tasks = []   // in the order registered (the first waiting section is the rail's target)

    function set(id, t) {
      if (typeof id !== 'string' || !id || !t || !t.text) return clear(id)
      const task = {
        id,
        page: PAGES.includes(t.page) ? t.page : 'settings',
        section: typeof t.section === 'string' ? t.section : '',
        level: LEVELS.includes(t.level) ? t.level : 'task',
        text: String(t.text)
      }
      const at = tasks.findIndex((x) => x.id === id)
      if (at >= 0 && JSON.stringify(tasks[at]) === JSON.stringify(task)) return
      tasks = at >= 0 ? tasks.map((x, i) => (i === at ? task : x)) : tasks.concat([task])
      onChange()
    }
    function clear(id) {
      const next = tasks.filter((x) => x.id !== id)
      if (next.length !== tasks.length) { tasks = next; onChange() }
    }
    const has = (id) => tasks.some((x) => x.id === id)

    // the dots: per page (rail item: every waiting text, one per line) and per section ('page/section':
    // its first task's text), and each page's target (the first waiting section, '' for a page-wide task)
    function dots() {
      const pages = {}
      const sections = {}
      const targets = {}
      // loop: NOT-WORTH — N ≤ ~12 tasks; on change
      for (const t of tasks) {
        pages[t.page] = pages[t.page] ? pages[t.page] + '\n' + t.text : t.text
        if (t.section) {
          const k = t.page + '/' + t.section
          if (!sections[k]) sections[k] = t.text
          if (!targets[t.page]) targets[t.page] = t.section
        }
      }
      return { pages, sections, targets }
    }
    // where a press on the page's rail item goes: the first waiting section, or '' (the page as it was)
    const target = (page) => dots().targets[page] || ''

    return { set, clear, has, dots, target, all: () => tasks.map((t) => Object.assign({}, t)) }
  }

  const api = { PAGES, LEVELS, createTasks }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataTasks = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
