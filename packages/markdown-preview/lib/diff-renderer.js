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
    if (del.closest('pre')) continue // diffed by line already

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

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, td'

// Replace `el` with its children.
function unwrap(el) {
  const parent = el.parentNode
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

// Reduce merged diff markup (in place) to one of its two versions, keeping
// inline formatting: `side` 'del' leaves the old text (everything minus the
// insertions), 'ins' the new one. Elements marked via `data-diff-node` are
// dropped whole on the side they don't belong to, and keep their tag (minus
// htmldiff's bookkeeping attributes) on the side they do.
function keepSide(root, side) {
  const gone = side === 'del' ? 'ins' : 'del'
  for (const el of Array.from(root.querySelectorAll(gone))) el.remove()
  for (const el of Array.from(root.querySelectorAll(side))) unwrap(el)
  for (const el of Array.from(root.querySelectorAll('[data-diff-node]'))) {
    if (el.getAttribute('data-diff-node') === gone) el.remove()
    else el.removeAttribute('data-diff-node')
  }
  for (const el of Array.from(root.querySelectorAll('[data-operation-index]'))) {
    el.removeAttribute('data-operation-index')
  }
}

// Word-diffing a block that was *rewritten* (rather than edited) shreds it into
// alternating del/ins fragments that read as noise: the old and new sentences
// are interleaved word by word and neither can be read. Past a churn threshold,
// stop pretending it's an edit — split the block in two, the old text then the
// new one, each whole and readable.
//
// Churn is (text inside ins+del) / (text in the block). Both sides of a
// replacement are counted, so a full rewrite tends to 1 while a small edit
// stays near 0. `ratio` is that fraction; <= 0 disables the split entirely.
//
// Only blocks with no block descendants are considered (a `li > p` splits the
// `p`, not the whole item), and only those holding *both* kinds of mark: pure
// additions and removals are already whole.
function splitRewrittenBlocks(root, ratio) {
  if (ratio <= 0) return

  // Short blocks churn easily (a 3-word heading rewrites at ratio 1), and a
  // word diff stays readable there — keep it.
  const MIN_WORDS = 6

  const blocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter(
    el => el.querySelector(BLOCK_SELECTOR) == null
  )

  for (const block of blocks) {
    // htmldiff marks changed *text* with ins/del wrappers, but a changed
    // *element* (a code span, a link) keeps its tag and gets a `data-diff-node`
    // attribute instead — both count.
    const marks = Array.from(
      block.querySelectorAll('ins, del, [data-diff-node]')
    )
    const isIns = m =>
      m.nodeName === 'INS' || m.getAttribute('data-diff-node') === 'ins'
    const isDel = m =>
      m.nodeName === 'DEL' || m.getAttribute('data-diff-node') === 'del'
    if (!marks.some(isIns)) continue
    if (!marks.some(isDel)) continue
    if (wordCount(block.textContent) < MIN_WORDS) continue

    const total = block.textContent.trim().length
    if (!total) continue
    const changed = marks.reduce((n, m) => n + m.textContent.trim().length, 0)
    if (changed / total < ratio) continue

    const oldBlock = block.cloneNode(true)
    keepSide(oldBlock, 'del')

    const newBlock = block.cloneNode(true)
    keepSide(newBlock, 'ins')

    // Whitespace around removed marks can leave doubled spaces behind.
    oldBlock.normalize()
    newBlock.normalize()

    oldBlock.classList.add('diff-block-removed', 'diff-block-whole')
    newBlock.classList.add('diff-block-added', 'diff-block-whole')

    block.parentNode.insertBefore(oldBlock, block)
    block.parentNode.insertBefore(newBlock, block)
    block.remove()
  }
}

// The text nodes under `root`, in document order.
function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

// A Range over `root`'s text from character `start` to `end`.
function textRange(root, start, end) {
  const range = document.createRange()
  range.selectNodeContents(root)
  let at = 0
  let started = false
  for (const node of textNodes(root)) {
    const next = at + node.data.length
    if (!started && start < next) {
      range.setStart(node, start - at)
      started = true
    }
    if (started && end <= next) {
      range.setEnd(node, end - at)
      break
    }
    at = next
  }
  return range
}

// The formatted content of `root`'s text from `start` to `end`. Cloning a range
// copies the inline elements it cuts through, empty ones included — drop those.
function textSlice(root, start, end) {
  const fragment = textRange(root, start, end).cloneContents()
  for (const el of Array.from(fragment.querySelectorAll('*')).reverse()) {
    if (!el.textContent && !el.matches('img, br') && !el.querySelector('img, br'))
      el.remove()
  }
  return fragment
}

// Which side of the diff a text node belongs to inside `block`: 'ins', 'del',
// or null for text both versions share.
function sideOf(node, block) {
  for (let el = node.parentElement; el && el !== block; el = el.parentElement) {
    if (el.nodeName === 'INS') return 'ins'
    if (el.nodeName === 'DEL') return 'del'
    const marked = el.getAttribute('data-diff-node')
    if (marked) return marked
  }
  return null
}

// Punctuation that closes a sentence or a clause — with any closing quote or
// bracket, and only before a space (so `1.5`, `e.g.x` or `a,b` don't count).
const CLAUSE_END = /[.!?;:,–—]["'’”)\]]*(?=\s|$)/g

const isWordChar = c => c != null && /[\p{L}\p{N}_]/u.test(c)

// Prose has structure a word diff ignores: a sentence rewritten mid-way comes
// out as old and new words woven together, with a few shared ones ("the",
// "reader") stitching the soup. Punctuation that *both* versions share marks
// where the two texts are back in step, so cut the block into clauses there and
// look at each on its own. A clause whose changed part (first change to last)
// is mostly change becomes one replacement — the old wording, then the new —
// with the shared words at its ends kept outside. Clauses that only got a light
// edit keep their word diff.
//
// `ratio` is the same churn fraction as `splitRewrittenBlocks`, measured on
// that changed part; <= 0 disables the pass.
function coarsenClauses(root, ratio) {
  if (ratio <= 0) return

  const blocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter(
    el => el.querySelector(BLOCK_SELECTOR) == null
  )

  for (const block of blocks) {
    if (!block.querySelector('ins, del, [data-diff-node]')) continue

    const spans = []
    const cuts = [0]
    let at = 0
    for (const node of textNodes(block)) {
      const side = sideOf(node, block)
      if (!side) {
        for (const m of node.data.matchAll(CLAUSE_END)) {
          cuts.push(at + m.index + m[0].length)
        }
      }
      spans.push({ node, side, start: at, end: at + node.data.length })
      at += node.data.length
    }
    cuts.push(at)

    // Last clause first: rewriting one only shifts the offsets after it.
    let changed = false
    for (let k = cuts.length - 2; k >= 0; k--) {
      if (coarsenClause(block, spans, cuts[k], cuts[k + 1], ratio)) changed = true
    }
    if (changed) block.normalize()
  }
}

// See `coarsenClauses`. Returns whether the clause [start, end) was rewritten.
function coarsenClause(block, spans, start, end, ratio) {
  const inside = spans.filter(s => s.end > start && s.start < end)
  const marked = inside.filter(s => s.side)
  if (!marked.some(s => s.side === 'ins')) return false
  if (!marked.some(s => s.side === 'del')) return false

  // Churn over the changed part only: a long untouched lead-in says nothing
  // about how readable the edit is.
  const from = marked[0].start
  const to = marked[marked.length - 1].end
  let changedChars = 0
  let commonChars = 0
  for (const s of inside) {
    const text = s.node.data.slice(
      Math.max(from, s.start) - s.start,
      Math.min(to, s.end) - s.start
    )
    const n = text.replace(/\s+/g, '').length
    if (s.side) changedChars += n
    else commonChars += n
  }
  // Nothing shared in between: already a plain replacement.
  if (!commonChars) return false
  if (changedChars / (changedChars + commonChars) < ratio) return false

  const range = textRange(block, start, end)
  const oldSide = document.createElement('div')
  oldSide.appendChild(range.cloneContents())
  const newSide = oldSide.cloneNode(true)
  keepSide(oldSide, 'del')
  keepSide(newSide, 'ins')
  const a = oldSide.textContent
  const b = newSide.textContent

  // Shared words at both ends stay outside the replacement — whole words only.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  while (head > 0 && isWordChar(a[head - 1]) && (isWordChar(a[head]) || isWordChar(b[head])))
    head--
  let tail = 0
  const maxTail = Math.min(a.length, b.length) - head
  while (tail < maxTail && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  while (
    tail > 0 &&
    isWordChar(a[a.length - tail]) &&
    (isWordChar(a[a.length - tail - 1]) || isWordChar(b[b.length - tail - 1]))
  )
    tail--

  const replacement = document.createDocumentFragment()
  replacement.appendChild(textSlice(newSide, 0, head))
  if (head < a.length - tail) {
    const del = document.createElement('del')
    del.appendChild(textSlice(oldSide, head, a.length - tail))
    replacement.appendChild(del)
  }
  if (head < b.length - tail) {
    const ins = document.createElement('ins')
    ins.appendChild(textSlice(newSide, head, b.length - tail))
    replacement.appendChild(ins)
  }
  replacement.appendChild(textSlice(newSide, b.length - tail, b.length))

  range.deleteContents()
  range.insertNode(replacement)
  return true
}

// Markdown's own `~~strikethrough~~` renders as `<del>` (and `<ins>`/`<s>` can
// come from raw HTML in the source) — the very tags htmldiff uses to mark
// changes. Left alone, an authored strikethrough reads as "this was deleted"
// and gets dropped from the new version of its block. Swap authored marks for
// neutral spans before diffing; `restoreAuthoredMarks` puts them back at the
// very end, once every pass that looks for ins/del has run.
function neutralizeAuthoredMarks(html) {
  // A plain div, not a <template>: we mutate the parsed nodes and serialize
  // them straight back, with no content-fragment round-trip in between.
  const holder = document.createElement('div')
  holder.innerHTML = html.trim()
  for (const el of Array.from(holder.querySelectorAll('del, ins, s'))) {
    const span = document.createElement('span')
    span.setAttribute('data-md-mark', el.tagName.toLowerCase())
    while (el.firstChild) span.appendChild(el.firstChild)
    el.parentNode.replaceChild(span, el)
  }
  return holder.innerHTML
}

function restoreAuthoredMarks(root) {
  for (const span of Array.from(root.querySelectorAll('[data-md-mark]'))) {
    const el = document.createElement(span.getAttribute('data-md-mark'))
    el.className = 'md-authored-mark' // so diff styling leaves it alone
    while (span.firstChild) el.appendChild(span.firstChild)
    span.parentNode.replaceChild(el, span)
  }
}

// Parse rendered HTML into its top-level blocks — the units we align.
function blockUnits(html) {
  const holder = document.createElement('div')
  holder.innerHTML = html.trim()
  return Array.from(holder.children)
}

// Identity for sequence alignment: same tag, same text. Whitespace is
// normalized so a reflow doesn't count as a change.
function blockKey(el) {
  return `${el.tagName} ${el.textContent.trim().replace(/\s+/g, ' ')}`
}

// How much of two blocks' text is shared, 0..1 — used to decide whether a
// removed and an added block are the same block edited, or two different ones.
function similarity(a, b) {
  const aText = a.textContent.trim()
  const bText = b.textContent.trim()
  if (!aText || !bText) return 0
  let common = 0
  for (const part of Diff.diffWordsWithSpace(aText, bText)) {
    if (!part.added && !part.removed) common += part.value.trim().length
  }
  return common / Math.max(aText.length, bText.length)
}

// Below this, a removed and an added block are considered unrelated and each is
// shown whole rather than word-diffed into each other.
const PAIR_MIN_SIMILARITY = 0.3
// Pairing is quadratic; past this hunk size, pair positionally instead.
const PAIR_MAX_HUNK = 40

// Match removed blocks to added ones within a hunk: greedy, best match first,
// order preserved for the rest. Returns a Map from removed index to added index.
function pairBlocks(removed, added) {
  const pairs = new Map()
  const takenNew = new Set()

  if (removed.length * added.length > PAIR_MAX_HUNK * PAIR_MAX_HUNK) {
    const count = Math.min(removed.length, added.length)
    for (let i = 0; i < count; i++) {
      if (removed[i].tagName === added[i].tagName) pairs.set(i, i)
    }
    return pairs
  }

  const scores = []
  for (let i = 0; i < removed.length; i++) {
    for (let j = 0; j < added.length; j++) {
      if (removed[i].tagName !== added[j].tagName) continue
      const score = similarity(removed[i], added[j])
      if (score >= PAIR_MIN_SIMILARITY) scores.push({ i, j, score })
    }
  }
  scores.sort((a, b) => b.score - a.score)

  for (const { i, j } of scores) {
    if (pairs.has(i) || takenNew.has(j)) continue
    pairs.set(i, j)
    takenNew.add(j)
  }
  return pairs
}

// Share of two strings' non-space text that a word diff keeps in common, 0..1.
function sharedRatio(a, b) {
  let common = 0
  let changed = 0
  for (const part of Diff.diffWordsWithSpace(a, b)) {
    const n = part.value.replace(/\s+/g, '').length
    if (part.added || part.removed) changed += n
    else common += 2 * n // present on both sides
  }
  return common + changed ? common / (common + changed) : 1
}

// Code is lines, not prose: diff it line by line, so a change spans the lines it
// touches and nothing else (a word diff happily starts an inserted line in the
// middle of its neighbour, and treats indentation as interchangeable spaces).
// A changed run that replaces as many lines as it removes is word-diffed line
// against line where those still mostly match; otherwise lines show whole.
// Highlighting is plain in diff mode, so the block's text is all there is.
function diffCodeBlock(oldEl, newEl) {
  const out = newEl.cloneNode(true)
  const target = out.querySelector('code') || out
  target.textContent = ''

  const mark = (tag, text) => {
    const el = document.createElement(tag)
    el.textContent = text
    target.appendChild(el)
  }

  const parts = Diff.diffLines(oldEl.textContent, newEl.textContent)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const next = parts[i + 1]
    if (part.removed && next && next.added && part.count === next.count) {
      const oldLines = part.value.split(/(?<=\n)/)
      const newLines = next.value.split(/(?<=\n)/)
      oldLines.forEach((oldLine, k) => {
        const newLine = newLines[k]
        if (sharedRatio(oldLine, newLine) < 0.5) {
          mark('del', oldLine)
          mark('ins', newLine)
          return
        }
        for (const word of Diff.diffWordsWithSpace(oldLine, newLine)) {
          if (word.added) mark('ins', word.value)
          else if (word.removed) mark('del', word.value)
          else target.appendChild(document.createTextNode(word.value))
        }
      })
      i++
    } else if (part.removed) {
      mark('del', part.value)
    } else if (part.added) {
      mark('ins', part.value)
    } else {
      target.appendChild(document.createTextNode(part.value))
    }
  }
  return out
}

// Word-diff two matching blocks against each other, in isolation, so a
// neighbour's edits can never bleed across the block boundary.
function diffBlockPair(oldEl, newEl) {
  if (oldEl.nodeName === 'PRE' && newEl.nodeName === 'PRE') {
    return [diffCodeBlock(oldEl, newEl)]
  }
  const holder = document.createElement('div')
  holder.innerHTML = htmldiff(oldEl.outerHTML, newEl.outerHTML).trim()
  return Array.from(holder.childNodes)
}

function wholeBlock(el, className) {
  const clone = el.cloneNode(true)
  clone.classList.add(className, 'diff-block-whole')
  return clone
}

// Align the two documents as *sequences of blocks* before diffing any text.
// htmldiff alone aligns words across the whole document, so when block
// boundaries move it happily matches the tail of one paragraph with the head of
// another and shreds both. Here: unchanged blocks pass through, a changed
// region pairs up the blocks that are recognizably the same block edited (those
// get the word diff, inside their own block), and whatever stays unmatched is
// shown whole — removed ones first, then the new content in document order.
function alignBlocks(oldHTML, newHTML) {
  const oldBlocks = blockUnits(oldHTML)
  const newBlocks = blockUnits(newHTML)

  const parts = Diff.diffArrays(oldBlocks.map(blockKey), newBlocks.map(blockKey))

  const fragment = document.createDocumentFragment()
  let oldAt = 0
  let newAt = 0
  let pendingRemoved = []

  const flush = addedRun => {
    const removed = pendingRemoved
    pendingRemoved = []
    const pairs = pairBlocks(removed, addedRun)
    const pairedNew = new Map()
    for (const [i, j] of pairs) pairedNew.set(j, i)

    // Everything that only went away, grouped first.
    removed.forEach((el, i) => {
      if (!pairs.has(i)) fragment.appendChild(wholeBlock(el, 'diff-block-removed'))
    })
    // Then the new content, in its own order: edited blocks as a word diff
    // against their old selves, brand new ones whole.
    addedRun.forEach((el, j) => {
      if (pairedNew.has(j)) {
        for (const node of diffBlockPair(removed[pairedNew.get(j)], el)) {
          fragment.appendChild(node)
        }
      } else {
        fragment.appendChild(wholeBlock(el, 'diff-block-added'))
      }
    })
  }

  for (const part of parts) {
    if (part.removed) {
      pendingRemoved.push(...oldBlocks.slice(oldAt, oldAt + part.count))
      oldAt += part.count
    } else if (part.added) {
      flush(newBlocks.slice(newAt, newAt + part.count))
      newAt += part.count
    } else {
      flush([])
      for (const el of newBlocks.slice(newAt, newAt + part.count)) {
        fragment.appendChild(el.cloneNode(true))
      }
      oldAt += part.count
      newAt += part.count
    }
  }
  flush([])

  return fragment
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

  // Align blocks first, then word-diff inside matched ones: <ins>/<del> wrap
  // changes while preserving structure. This shows removed (old) and added
  // (new) together. Authored marks are parked as spans for the whole pipeline,
  // so nothing below mistakes a `~~strikethrough~~` for a deletion.
  const fragment = alignBlocks(
    neutralizeAuthoredMarks(oldHTML),
    neutralizeAuthoredMarks(newHTML)
  )

  refineReplacements(fragment)
  mergeShortGaps(fragment, atom.config.get('markdown-preview.diffMergeMaxWords'))
  splitRewrittenBlocks(
    fragment,
    atom.config.get('markdown-preview.diffRewriteThreshold') / 100
  )
  coarsenClauses(
    fragment,
    atom.config.get('markdown-preview.diffRewriteThreshold') / 100
  )
  renderer.resolveImagePaths(fragment, filePath)
  addDiffGutters(fragment)
  restoreAuthoredMarks(fragment)

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
