// Sticky breadcrumb of the headings the reader is under: `h1 > h2 > h3`.
// Shown only once the reader is under a heading below the h1.
//
// The bar is a sticky first child of the preview (the preview is its own scroll
// container), laid over the container's top padding so the page keeps its
// layout. A heading becomes current the moment its top crosses the bar's
// bottom — not when it leaves the viewport — so the bar never names a section
// whose heading is still readable below it.
//
// Hovering a trail item below the h1 opens a menu of its siblings (same level,
// same parent section) to jump to.
//
// Rendering replaces the preview's children, so the view calls `attach()` after
// every render to put the bar back and re-collect the headings.

const HEADINGS = ':scope > :is(h1, h2, h3, h4, h5, h6)'

// Grace period to travel from a trail item to its menu (and back).
const MENU_CLOSE_DELAY = 200

const levelOf = heading => Number(heading.tagName[1])

module.exports = class HeadingBar {
  constructor(scroller) {
    this.scroller = scroller
    this.headings = []
    this.trail = []
    this.frame = 0
    this.menuHeadings = []
    this.closeTimer = 0

    this.element = document.createElement('div')
    this.element.className = 'markdown-preview-heading-bar'
    this.trailElement = document.createElement('div')
    this.trailElement.className = 'trail'
    this.menu = document.createElement('div')
    this.menu.className = 'menu'
    this.menu.hidden = true
    this.element.append(this.trailElement, this.menu)

    this.onScroll = () => {
      if (this.frame) return
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.update()
      })
    }
    // A hidden pane item has no box, so the trail can't be computed while the
    // preview is on a background tab (or not laid out yet, right after it
    // opens). Coming back fires no scroll event — but the box goes from
    // nothing to something, which this catches.
    this.resizeObserver = new ResizeObserver(this.onScroll)
    this.resizeObserver.observe(scroller)
    this.onClick = event => {
      const item = event.target.closest('[data-trail-index], [data-menu-index]')
      if (!item) return
      event.preventDefault()
      event.stopPropagation()
      const { trailIndex, menuIndex } = item.dataset
      if (menuIndex != null) {
        this.closeMenu()
        this.scrollTo(this.menuHeadings[Number(menuIndex)])
      } else {
        this.scrollTo(this.trail[Number(trailIndex)])
      }
    }
    // On an item: its menu. In the menu: keep it. Elsewhere, bar included:
    // close, unless the pointer gets back in time.
    this.onMouseOver = event => {
      const item = event.target.closest('[data-trail-index]')
      if (item) this.openMenu(item)
      else if (this.menu.contains(event.target)) this.keepMenu()
      else this.scheduleCloseMenu()
    }
    this.onMouseOut = event => {
      if (!this.element.contains(event.relatedTarget)) this.scheduleCloseMenu()
    }

    scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.element.addEventListener('click', this.onClick)
    this.element.addEventListener('mouseover', this.onMouseOver)
    this.element.addEventListener('mouseout', this.onMouseOut)
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    clearTimeout(this.closeTimer)
    this.resizeObserver.disconnect()
    this.scroller.removeEventListener('scroll', this.onScroll)
    this.element.remove()
  }

  attach() {
    // Spread to the container's edges, over the padding its own sides restore.
    const style = getComputedStyle(this.scroller)
    this.paddingTop = style.paddingTop
    Object.assign(this.element.style, {
      top: `-${style.paddingTop}`,
      marginLeft: `-${style.paddingLeft}`,
      marginRight: `-${style.paddingRight}`,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight
    })
    this.applyGeometry()
    if (this.scroller.firstChild !== this.element) {
      this.scroller.prepend(this.element)
    }

    // A block removed in diff mode is old content: not a section anymore.
    this.headings = Array.from(this.scroller.querySelectorAll(HEADINGS)).filter(
      el => !el.classList.contains('diff-block-removed')
    )
    this.trail = null // force a redraw: the elements are new
    this.closeMenu()
    this.update()
  }

  // Current heading = the last whose top has crossed the bar's bottom; its
  // trail = it, then each nearest preceding heading of a higher rank.
  update() {
    // No box to measure against: keep what we have rather than settle on the
    // empty trail every rect-at-zero would produce. The resize observer calls
    // back once there is one.
    if (!this.element.isConnected || !this.scroller.clientHeight) return
    const barBottom = this.element.getBoundingClientRect().bottom

    // Top-level headings are in document order, so their tops are sorted.
    let lo = 0
    let hi = this.headings.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.headings[mid].getBoundingClientRect().top < barBottom) lo = mid + 1
      else hi = mid
    }

    let trail = []
    let rank = 7
    for (let i = lo - 1; i >= 0 && rank > 1; i--) {
      const level = levelOf(this.headings[i])
      if (level < rank) {
        trail.unshift(this.headings[i])
        rank = level
      }
    }
    // Under the h1 alone, the bar would only repeat the title: stay empty.
    if (!trail.some(el => levelOf(el) > 1)) trail = []

    if (
      this.trail &&
      trail.length === this.trail.length &&
      trail.every((el, i) => el === this.trail[i])
    ) {
      return
    }
    this.trail = trail
    this.render()
  }

  // Shown, the bar takes the place of the container's top padding: pulled up
  // over it and at least as tall, so content neither moves nor shows through.
  // Empty, it takes no room at all — no invisible band swallowing the text
  // that scrolls past the top.
  applyGeometry() {
    const empty = !this.trail || this.trail.length === 0
    this.element.style.marginTop = empty ? '0px' : `-${this.paddingTop}`
    this.element.style.minHeight = empty ? '0px' : this.paddingTop
  }

  render() {
    this.trailElement.textContent = ''
    this.element.classList.toggle('is-empty', this.trail.length === 0)
    this.applyGeometry()
    if (this.trail.length === 0) this.closeMenu()
    this.trail.forEach((heading, i) => {
      if (i > 0) {
        const sep = document.createElement('span')
        sep.className = 'separator'
        sep.textContent = '>'
        this.trailElement.appendChild(sep)
      }
      const item = document.createElement('a')
      item.className = `item level-${levelOf(heading)}`
      item.dataset.trailIndex = i
      // The document title is mostly redundant up here: a mark that still
      // jumps to it, the text on hover.
      const text = headingText(heading)
      item.textContent = heading.tagName === 'H1' ? '#' : text
      item.title = text
      this.trailElement.appendChild(item)
    })
  }

  // Headings at `heading`'s level in its parent's section, `heading` included.
  siblingsOf(heading) {
    const level = levelOf(heading)
    const at = this.headings.indexOf(heading)
    let start = at
    while (start > 0 && levelOf(this.headings[start - 1]) >= level) start--
    let end = at + 1
    while (end < this.headings.length && levelOf(this.headings[end]) >= level) end++
    return this.headings
      .slice(start, end)
      .filter(el => levelOf(el) === level)
  }

  openMenu(item) {
    this.keepMenu()
    const heading = this.trail[Number(item.dataset.trailIndex)]
    if (!heading || levelOf(heading) === 1) return this.closeMenu()
    if (!this.menu.hidden && this.menuFor === heading) return

    this.menuFor = heading
    this.menuHeadings = this.siblingsOf(heading)
    this.menu.textContent = ''
    this.menuHeadings.forEach((sibling, i) => {
      const entry = document.createElement('a')
      entry.className = 'menu-item'
      entry.classList.toggle('is-current', sibling === heading)
      entry.dataset.menuIndex = i
      entry.textContent = headingText(sibling)
      this.menu.appendChild(entry)
    })
    // Under its item; `offsetLeft` is against the bar (sticky = positioned).
    this.menu.style.left = `${item.offsetLeft}px`
    this.menu.hidden = false
    // A long list opens on the current entry (by hand: `scrollIntoView` would
    // scroll the preview too).
    const current = this.menu.querySelector('.is-current')
    this.menu.scrollTop = current.offsetTop - this.menu.clientHeight / 2
  }

  keepMenu() {
    clearTimeout(this.closeTimer)
    this.closeTimer = 0
  }

  scheduleCloseMenu() {
    this.keepMenu()
    this.closeTimer = setTimeout(() => this.closeMenu(), MENU_CLOSE_DELAY)
  }

  closeMenu() {
    this.keepMenu()
    this.menu.hidden = true
    this.menuFor = null
    this.menuHeadings = []
  }

  // Bring `heading` right below the bar — shown, not yet current.
  scrollTo(heading) {
    if (!heading || !heading.isConnected) return
    const barBottom = this.element.getBoundingClientRect().bottom
    const delta = heading.getBoundingClientRect().top - barBottom
    this.scroller.scrollTop = Math.floor(this.scroller.scrollTop + delta)
  }
}

// A heading's text as it reads now: in diff mode, without what was deleted.
function headingText(heading) {
  const clone = heading.cloneNode(true)
  for (const el of clone.querySelectorAll('del, [data-diff-node="del"]')) {
    if (!el.classList.contains('md-authored-mark')) el.remove()
  }
  return clone.textContent.trim().replace(/\s+/g, ' ')
}
