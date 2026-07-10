const path = require('path')
const { execFileSync } = require('child_process')

const renderer = require('./renderer')
const htmldiff = require('node-htmldiff')
const Diff = require('diff')

// Read the base version of `filePath` from git to diff the working copy
// against. `base` is 'head' (committed — `HEAD:path`) or 'index' (staged, what
// `git diff` compares against by default — `:path`). Returns the content, or
// `null` when the file is untracked / new / not in a repo.
//
// This is intentionally *synchronous*: an async `child_process` callback can
// fire after the preview's renderer window has been torn down (e.g. during a
// reload), which crashes Electron with `MakeCallback ... env != nullptr`. A
// sync call completes before teardown, so there's no dangling callback.
function gitShowBase(filePath, base) {
  const cwd = path.dirname(filePath)
  const ref = base === 'index' ? '' : 'HEAD' // ':path' = index, 'HEAD:path' = committed
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const rel = path.relative(top, filePath)
    return execFileSync('git', ['-C', top, 'show', `${ref}:${rel}`], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    // Not a repo, or path not in the base tree (new file) — treat as empty so
    // everything shows as added.
    return null
  }
}

// htmldiff matches whole whitespace-delimited tokens, so `monsieur` vs
// `monsieur,` (comma attached) don't match and it emits a dumb
// `<del>monsieur</del><ins>monsieur, and madame</ins>` replacement. Re-diff each
// adjacent del/ins text pair at the word level (jsdiff) to pull out the shared
// text and leave a minimal change. Only pure-text pairs are refined, so inline
// formatting inside a change is left untouched.
function refineReplacements(root) {
  for (const del of Array.from(root.querySelectorAll('del'))) {
    const ins = del.nextSibling
    if (!ins || ins.nodeName !== 'INS') continue
    if (del.children.length || ins.children.length) continue

    const parts = Diff.diffWordsWithSpace(del.textContent, ins.textContent)
    const fragment = document.createDocumentFragment()
    for (const part of parts) {
      if (part.added) {
        const node = document.createElement('ins')
        node.textContent = part.value
        fragment.appendChild(node)
      } else if (part.removed) {
        const node = document.createElement('del')
        node.textContent = part.value
        fragment.appendChild(node)
      } else {
        fragment.appendChild(document.createTextNode(part.value))
      }
    }
    del.parentNode.insertBefore(fragment, del)
    ins.remove()
    del.remove()
  }
}

function wordCount(text) {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

// Coarsen fragmented word-diffs. Within a block, htmldiff can produce
// `<del>a</del> kept <ins>b</ins> more <del>c</del>...` where short runs of
// unchanged words are sandwiched between changes. When such a replacement
// region (containing both deletions and insertions) is broken up only by short
// shared runs (< `maxGap` words), merge it into a single
// `<del>old</del><ins>new</ins>` pair — a chunk/line-level diff instead of a
// noisy word-level one. Isolated or pure add/remove changes are left intact so
// their inline formatting is preserved.
function mergeShortGaps(root, maxGap) {
  if (maxGap <= 0) return

  const parents = new Set()
  for (const mark of root.querySelectorAll('ins, del')) {
    if (mark.parentElement) parents.add(mark.parentElement)
  }

  for (const parent of parents) {
    const nodes = Array.from(parent.childNodes)
    const typeOf = n =>
      n.nodeName === 'DEL' ? 'del' : n.nodeName === 'INS' ? 'ins' : 'common'

    let i = 0
    while (i < nodes.length) {
      if (typeOf(nodes[i]) === 'common') {
        i++
        continue
      }
      // Start a cluster at the first change; extend across short common gaps.
      let j = i
      let hasDel = false
      let hasIns = false
      let changeCount = 0
      let k = i
      while (k < nodes.length) {
        const t = typeOf(nodes[k])
        if (t === 'common') {
          // Look ahead: is there another change after this gap, and is the gap
          // short enough to absorb?
          let gapWords = 0
          let m = k
          while (m < nodes.length && typeOf(nodes[m]) === 'common') {
            gapWords += wordCount(nodes[m].textContent)
            m++
          }
          if (m < nodes.length && gapWords < maxGap) {
            k = m // absorb the gap, continue the cluster
            continue
          }
          break // gap too big or nothing after — cluster ends at j
        }
        if (t === 'del') hasDel = true
        else hasIns = true
        changeCount++
        j = k
        k++
      }

      if (changeCount >= 2 && hasDel && hasIns) {
        // Rebuild old/new text from the cluster [i..j].
        let oldText = ''
        let newText = ''
        for (let p = i; p <= j; p++) {
          const t = typeOf(nodes[p])
          const text = nodes[p].textContent
          if (t === 'del') oldText += text
          else if (t === 'ins') newText += text
          else {
            oldText += text
            newText += text
          }
        }
        const del = document.createElement('del')
        del.textContent = oldText
        const ins = document.createElement('ins')
        ins.textContent = newText
        parent.insertBefore(del, nodes[i])
        parent.insertBefore(ins, nodes[i])
        for (let p = i; p <= j; p++) parent.removeChild(nodes[p])
      }

      i = j + 1
    }
  }
}

// Tag block-level elements with a gutter class based on the inline diff marks
// (`<ins>` / `<del>`) they contain, so CSS can draw red/blue/purple gutters.
// Only the outermost changed block is tagged — a nested block whose ancestor
// already carries a gutter is skipped, so e.g. a loose list item (`<li><p>`)
// gets a single bar instead of one on both the `li` and the inner `p`.
function addDiffGutters(root) {
  const blockSelector =
    'p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, table, tr, img'
  // `querySelectorAll` is in document order, so an ancestor is always visited
  // and classed before its descendants.
  for (const el of root.querySelectorAll(blockSelector)) {
    if (
      el.parentElement &&
      el.parentElement.closest(
        '.diff-block-added, .diff-block-removed, .diff-block-changed'
      )
    ) {
      continue
    }
    const hasIns = el.querySelector('ins') != null || el.tagName === 'INS'
    const hasDel = el.querySelector('del') != null || el.tagName === 'DEL'
    if (hasIns && hasDel) {
      el.classList.add('diff-block-changed')
    } else if (hasIns) {
      el.classList.add('diff-block-added')
    } else if (hasDel) {
      el.classList.add('diff-block-removed')
    }
  }
}

// Render a rendered diff of `newSource` against its HEAD version. Returns a
// detached DOM fragment (code blocks left as plain `<pre>`; no editor
// highlighting in diff mode for now).
exports.toDiffFragment = async function (newSource, filePath) {
  const base = atom.config.get('markdown-preview.diffAgainstStaged')
    ? 'index'
    : 'head'
  const oldSource = filePath ? gitShowBase(filePath, base) : null

  const oldHTML = renderer.renderHTMLString(oldSource ?? '')
  const newHTML = renderer.renderHTMLString(newSource ?? '')

  // Word-level diff of the *rendered* HTML: <ins>/<del> wrap changes while
  // preserving structure. This shows removed (old) and added (new) together.
  const merged = htmldiff(oldHTML, newHTML)

  const template = document.createElement('template')
  template.innerHTML = merged.trim()
  const fragment = template.content.cloneNode(true)

  refineReplacements(fragment)
  mergeShortGaps(fragment, atom.config.get('markdown-preview.diffMergeMaxWords'))
  renderer.resolveImagePaths(fragment, filePath)
  addDiffGutters(fragment)

  // Source-only change detection: the file changed but rendered identically
  // (e.g. a reflow / prettier reformat). Surface it since the diff shows
  // nothing.
  const sourceChanged = oldSource != null && oldSource !== (newSource ?? '')
  const renderChanged = oldHTML !== newHTML
  if (sourceChanged && !renderChanged) {
    const banner = document.createElement('div')
    banner.className = 'diff-source-only-banner'
    banner.textContent =
      'Source changed but rendered output is identical (formatting only).'
    fragment.insertBefore(banner, fragment.firstChild)
  }

  return fragment
}
