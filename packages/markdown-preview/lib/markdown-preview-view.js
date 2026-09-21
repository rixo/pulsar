const path = require('path')
const morphdom = require('morphdom')

const { Emitter, Disposable, CompositeDisposable, File } = require('atom')
const _ = require('underscore-plus')
const fs = require('fs-plus')

const renderer = require('./renderer')
const HeadingBar = require('./heading-bar')

module.exports = class MarkdownPreviewView {
  static deserialize(params) {
    return new MarkdownPreviewView(params)
  }

  constructor({ editorId, filePath }) {
    this.editorId = editorId
    this.filePath = filePath
    this.element = document.createElement('div')
    this.element.classList.add('markdown-preview')
    this.element.tabIndex = -1

    this.emitter = new Emitter()
    this.loaded = false
    // Diff mode is a global toggle persisted in config, so all previews share
    // it and it survives a reload.
    this.diffMode = atom.config.get('markdown-preview.showDiff')
    this.disposables = new CompositeDisposable()
    this.headingBar = new HeadingBar(this.element)
    this.registerScrollCommands()
    if (this.editorId != null) {
      this.resolveEditor(this.editorId)
    } else if (atom.packages.hasActivatedInitialPackages()) {
      this.subscribeToFilePath(this.filePath)
    } else {
      this.disposables.add(
        atom.packages.onDidActivateInitialPackages(() => {
          this.subscribeToFilePath(this.filePath)
        })
      )
    }
    this.editorCache = new renderer.EditorCache(editorId)
  }

  serialize() {
    return {
      deserializer: 'MarkdownPreviewView',
      filePath: this.getPath() != null ? this.getPath() : this.filePath,
      editorId: this.editorId
    }
  }

  copy() {
    return new MarkdownPreviewView({
      editorId: this.editorId,
      filePath: this.getPath() != null ? this.getPath() : this.filePath
    })
  }

  destroy() {
    this.disposables.dispose()
    this.headingBar.destroy()
    this.element.remove()
    this.editorCache.destroy()
  }

  registerScrollCommands() {
    this.disposables.add(
      atom.commands.add(this.element, {
        'core:move-up': () => {
          this.element.scrollTop -= document.body.offsetHeight / 20
        },
        'core:move-down': () => {
          this.element.scrollTop += document.body.offsetHeight / 20
        },
        'core:page-up': () => {
          this.element.scrollTop -= this.element.offsetHeight
        },
        'core:page-down': () => {
          this.element.scrollTop += this.element.offsetHeight
        },
        'core:move-to-top': () => {
          this.element.scrollTop = 0
        },
        'core:move-to-bottom': () => {
          this.element.scrollTop = this.element.scrollHeight
        },
        'markdown-preview:go-to-next-change': () => this.moveToChange(1),
        'markdown-preview:go-to-previous-change': () => this.moveToChange(-1)
      })
    )
  }

  // Changed blocks, grouped into hunks: `diff-renderer` marks each block, and a
  // rewrite shows up as two adjacent blocks (old then new) — one hunk, one stop.
  // Only the outermost marked block of a nest counts (`li > p`). Each hunk is
  // the array of its blocks, in document order.
  getChangeHunks() {
    const marked = Array.from(
      this.element.querySelectorAll(
        '.diff-block-added, .diff-block-removed, .diff-block-changed'
      )
    ).filter(
      (el, _i, all) => !all.some(other => other !== el && other.contains(el))
    )

    const hunks = []
    let previous = null
    for (const el of marked) {
      if (previous && el.previousElementSibling === previous) {
        hunks[hunks.length - 1].push(el)
      } else {
        hunks.push([el])
      }
      previous = el
    }
    return hunks
  }

  // Scroll to the next (`direction` 1) or previous (-1) change, flashing
  // instead of wrapping around at the ends. Asking for a change implies wanting
  // to see changes, so this turns diff mode on when it's off (and renders)
  // rather than doing nothing.
  // Beeps when there is genuinely nothing to jump to.
  async moveToChange(direction) {
    if (!this.diffMode) {
      // The config observer flips this.diffMode and re-renders; await a render
      // of our own so the marked blocks exist before we measure them.
      atom.config.set('markdown-preview.showDiff', true)
      await this.renderMarkdown()
    }

    const hunks = this.getChangeHunks()
    if (hunks.length === 0) {
      atom.beep()
      return
    }

    // Measured from under the heading bar, so a change doesn't land behind it.
    // An empty bar has no height and sits above the viewport: it's the view's
    // own top that counts then, or the jump would overshoot by that much.
    const bar = this.headingBar.element
    const viewTop = Math.max(
      this.element.getBoundingClientRect().top,
      bar.isConnected ? bar.getBoundingClientRect().bottom : -Infinity
    )
    const offsetOf = el =>
      el.getBoundingClientRect().top - viewTop + this.element.scrollTop
    // Where jumping to a hunk actually lands — with a little air above, like
    // the editor's diff jump does, and clamped to what the document allows.
    // Comparing landings rather than offsets is what makes the ends symmetric:
    // the last hunks of a document share the bottom landing, so `next` would
    // otherwise keep finding an offset it can never scroll to and never
    // report the end, while `previous` hit it fine off the always-reachable top.
    const maxScroll = this.element.scrollHeight - this.element.clientHeight
    const landings = hunks.map(([first]) =>
      Math.min(Math.max(0, offsetOf(first) - 16), maxScroll)
    )
    // Tolerance so the hunk we're parked on doesn't count as the next one.
    const here = this.element.scrollTop
    const target =
      direction > 0
        ? landings.find(top => top > here + 2)
        : [...landings].reverse().find(top => top < here - 2)
    if (target == null) {
      // No wrapping: flash the document's very first / last hunk, all of its
      // blocks, to say "that's the end". Not the one we're parked on, which
      // at the bottom can be an earlier hunk sharing the clamped landing.
      // The whole view flashes instead when none of the hunk is on screen.
      const edge = direction > 0 ? hunks[hunks.length - 1] : hunks[0]
      const viewBottom = this.element.getBoundingClientRect().bottom
      const visible = edge.some(el => {
        const rect = el.getBoundingClientRect()
        return rect.bottom > viewTop && rect.top < viewBottom
      })
      if (visible) edge.forEach(el => this.flash(el))
      else this.flash(this.element)
      return
    }

    this.element.scrollTop = target
  }

  flash(el) {
    el.classList.remove('markdown-preview-flash')
    // Force a reflow so the animation restarts on repeated presses.
    void el.offsetWidth
    el.classList.add('markdown-preview-flash')
    el.addEventListener(
      'animationend',
      () => el.classList.remove('markdown-preview-flash'),
      { once: true }
    )
  }

  onDidChangeTitle(callback) {
    return this.emitter.on('did-change-title', callback)
  }

  onDidChangeModified(_callback) {
    // No op to suppress deprecation warning
    return new Disposable()
  }

  onDidChangeMarkdown(callback) {
    return this.emitter.on('did-change-markdown', callback)
  }

  subscribeToFilePath(filePath) {
    this.file = new File(filePath)
    this.emitter.emit('did-change-title')
    this.disposables.add(
      this.file.onDidRename(() => this.emitter.emit('did-change-title'))
    )
    this.handleEvents()
    return this.renderMarkdown()
  }

  resolveEditor(editorId) {
    const resolve = () => {
      this.editor = this.editorForId(editorId)

      if (this.editor != null) {
        this.emitter.emit('did-change-title')
        this.disposables.add(
          this.editor.onDidDestroy(() =>
            this.subscribeToFilePath(this.getPath())
          )
        )
        this.handleEvents()
        this.renderMarkdown()
      } else {
        this.subscribeToFilePath(this.filePath)
      }
    }

    if (atom.packages.hasActivatedInitialPackages()) {
      resolve()
    } else {
      this.disposables.add(atom.packages.onDidActivateInitialPackages(resolve))
    }
  }

  editorForId(editorId) {
    for (const editor of atom.workspace.getTextEditors()) {
      if (editor.id != null && editor.id.toString() === editorId.toString()) {
        return editor
      }
    }
    return null
  }

  handleEvents() {
    const lazyRenderMarkdown = _.debounce(() => this.renderMarkdown(), 250)
    this.disposables.add(
      atom.grammars.onDidAddGrammar(() => lazyRenderMarkdown())
    )
    if (typeof atom.grammars.onDidRemoveGrammar === 'function') {
      this.disposables.add(
        atom.grammars.onDidRemoveGrammar(() => lazyRenderMarkdown())
      )
    } else {
      // TODO: Remove onDidUpdateGrammar hook once onDidRemoveGrammar is released
      this.disposables.add(
        atom.grammars.onDidUpdateGrammar(() => lazyRenderMarkdown())
      )
    }

    atom.commands.add(this.element, {
      'core:copy': event => {
        event.stopPropagation()
        return this.copyToClipboard()
      },
      'markdown-preview:select-all': () => {
        this.selectAll()
      },
      'markdown-preview:toggle-diff': () => {
        const keyPath = 'markdown-preview.showDiff'
        atom.config.set(keyPath, !atom.config.get(keyPath))
      },
      'markdown-preview:zoom-in': () => {
        const zoomLevel = parseFloat(getComputedStyle(this.element).zoom)
        this.element.style.zoom = zoomLevel + 0.1
      },
      'markdown-preview:zoom-out': () => {
        const zoomLevel = parseFloat(getComputedStyle(this.element).zoom)
        this.element.style.zoom = zoomLevel - 0.1
      },
      'markdown-preview:reset-zoom': () => {
        this.element.style.zoom = 1
      },
      'markdown-preview:toggle-break-on-single-newline'() {
        const keyPath = 'markdown-preview.breakOnSingleNewline'
        atom.config.set(keyPath, !atom.config.get(keyPath))
      },
      'markdown-preview:toggle-github-style'() {
        const keyPath = 'markdown-preview.useGitHubStyle'
        atom.config.set(keyPath, !atom.config.get(keyPath))
      }
    })

    const changeHandler = () => {
      this.renderMarkdown()

      const pane = atom.workspace.paneForItem(this)
      if (pane != null && pane !== atom.workspace.getActivePane()) {
        pane.activateItem(this)
      }
    }

    if (this.file) {
      this.disposables.add(this.file.onDidChange(changeHandler))
    } else if (this.editor) {
      this.disposables.add(
        this.editor.getBuffer().onDidStopChanging(function () {
          if (atom.config.get('markdown-preview.liveUpdate')) {
            changeHandler()
          }
        })
      )
      this.disposables.add(
        this.editor.onDidChangePath(() => this.emitter.emit('did-change-title'))
      )
      this.disposables.add(
        this.editor.getBuffer().onDidSave(function () {
          if (!atom.config.get('markdown-preview.liveUpdate')) {
            changeHandler()
          }
        })
      )
      this.disposables.add(
        this.editor.getBuffer().onDidReload(function () {
          if (!atom.config.get('markdown-preview.liveUpdate')) {
            changeHandler()
          }
        })
      )
    }

    this.disposables.add(
      atom.config.onDidChange(
        'markdown-preview.breakOnSingleNewline',
        changeHandler
      )
    )

    this.disposables.add(
      atom.config.onDidChange('markdown-preview.showDiff', ({ newValue }) => {
        this.diffMode = newValue
        this.renderMarkdown()
      })
    )

    this.disposables.add(
      atom.config.onDidChange('markdown-preview.diffAgainstStaged', () => {
        if (this.diffMode) this.renderMarkdown()
      })
    )

    // Refresh the diff when git state changes (staging, unstaging, committing),
    // since those alter the base we diff against without touching the buffer.
    const refreshDiffOnGitChange = _.debounce(() => {
      if (this.diffMode) this.renderMarkdown()
    }, 300)
    for (const repo of atom.project.getRepositories()) {
      if (repo) {
        this.disposables.add(repo.onDidChangeStatuses(refreshDiffOnGitChange))
      }
    }

    this.disposables.add(
      atom.config.observe('markdown-preview.gitHubStyleMode', gitHubStyleMode => {
        this.gitHubStyleMode = gitHubStyleMode
        if (this.useGitHubStyle) {
          this.element.setAttribute('data-use-github-style', gitHubStyleMode)
        }
      })
    )

    this.disposables.add(
      atom.config.observe('markdown-preview.useGitHubStyle', useGitHubStyle => {
        this.useGitHubStyle = useGitHubStyle
        if (useGitHubStyle) {
          this.element.setAttribute('data-use-github-style', this.gitHubStyleMode)
        } else {
          this.element.removeAttribute('data-use-github-style')
        }
      })
    )

    // Single-click a relative link to a local file: resolve it against the
    // previewed file's directory. Markdown targets open as a preview; anything
    // else opens normally. External links (http, mailto, atom, …) and in-page
    // anchors keep their default behavior.
    const onLinkClick = event => {
      const link = event.target.closest('a')
      if (link == null || !this.element.contains(link)) {
        return
      }
      const href = link.getAttribute('href')
      if (!href || href.startsWith('#')) {
        return
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        // Has a URI scheme (http:, mailto:, atom:, file:, …) — not a relative
        // path; let the default handler deal with it.
        return
      }
      const base = this.getPath()
      if (!base) {
        return
      }
      event.preventDefault()
      let [rel] = href.split('#')
      try {
        rel = decodeURI(rel)
      } catch (e) {
        // Keep the raw value if it isn't valid URI-encoded text.
      }
      const target = path.resolve(path.dirname(base), rel)
      if (/\.(md|markdown|mdown|mkd|mkdown|ron)$/i.test(target)) {
        atom.workspace.open(`markdown-preview://${encodeURI(target)}`, {
          searchAllPanes: true
        })
      } else {
        atom.workspace.open(target)
      }
    }
    this.element.addEventListener('click', onLinkClick)
    this.disposables.add(
      new Disposable(() =>
        this.element.removeEventListener('click', onLinkClick)
      )
    )

    document.onselectionchange = () => {
      const selection = window.getSelection()
      const selectedNode = selection.baseNode
      if (
        selectedNode === null ||
        this.element === selectedNode ||
        this.element.contains(selectedNode)
      ) {
        if (selection.isCollapsed) {
          this.element.classList.remove('has-selection')
        } else {
          this.element.classList.add('has-selection')
        }
      }
    }
  }

  renderMarkdown() {
    if (!this.loaded) {
      this.showLoading()
    }
    return this.getMarkdownSource()
      .then(source => {
        if (source != null) {
          if (this.loaded) {
            return this.renderMarkdownText(source);
          } else {
            // If we haven't loaded yet, defer before we render the Markdown
            // for the first time. This allows the pane to appear and to
            // display the loading indicator. Otherwise the first render
            // happens before the pane is even visible.
            //
            // This doesn't slow anything down; it just shifts the work around
            // so that the pane appears earlier in the cycle.
            return new Promise((resolve) => {
              setTimeout(() => {
                resolve(this.renderMarkdownText(source))
              }, 0)
            })
          }
        }
      })
      .catch(reason => this.showError({ message: reason }))
  }

  getMarkdownSource() {
    if (this.file && this.file.getPath()) {
      return this.file
        .read()
        .then(source => {
          if (source === null) {
            return Promise.reject(
              new Error(`${this.file.getBaseName()} could not be found`)
            )
          } else {
            return Promise.resolve(source)
          }
        })
        .catch(reason => Promise.reject(reason))
    } else if (this.editor != null) {
      return Promise.resolve(this.editor.getText())
    } else {
      return Promise.reject(new Error('No editor found'))
    }
  }

  async getHTML() {
    const source = await this.getMarkdownSource()

    if (source == null) {
      return
    }

    return renderer.toHTML(source, this.getPath(), this.getGrammar())
  }

  async renderMarkdownText(text) {
    if (this.diffMode) {
      return this.renderDiffText(text)
    }

    const { scrollTop } = this.element
    try {
      if (this.diffRendered) {
        // Leaving diff mode: morphdom can't cleanly reconcile the very
        // different diff tree (<ins>/<del>, gutters) into the normal one and
        // leaves stale nodes behind, so start from a blank slate.
        this.element.textContent = ''
        this.diffRendered = false
      }
      this.element.classList.remove('markdown-preview-diff')
      const [domFragment, done] = await renderer.toDOMFragment(
        text,
        this.getPath(),
        this.getGrammar(),
        this.editorId
      )

      this.loading = false
      this.loaded = true

      // Clone the existing container
      let newElement = this.element.cloneNode(false)
      newElement.appendChild(domFragment)

      // Out of the way first, or morphdom could morph the bar into content.
      this.headingBar.element.remove()
      morphdom(this.element, newElement, {
        onBeforeNodeDiscarded(node) {
          // Don't discard `atom-text-editor` elements despite the fact that
          // they don't exist in the new content.
          if (node.nodeName === 'ATOM-TEXT-EDITOR') {
            return false
          }
        }
      })

      this.headingBar.attach()

      await done(this.element)
      this.element.classList.remove('loading')

      this.emitter.emit('did-change-markdown')
      this.element.scrollTop = scrollTop
      // `attach` measured the trail at whatever scroll the new content started
      // at; this is where the reader actually is.
      this.headingBar.update()
    } catch (error) {
      this.showError(error)
    }
  }

  async renderDiffText(text) {
    const { scrollTop } = this.element
    try {
      const diffRenderer = require('./diff-renderer')
      const fragment = await diffRenderer.toDiffFragment(text, this.getPath())

      this.loading = false
      this.loaded = true

      // Full replace rather than morphdom: the diff tree changes shape
      // unpredictably between renders (word merges, gutters), and morphdom
      // leaves stale nodes that pile up across re-renders/toggles.
      this.element.textContent = ''
      this.element.appendChild(fragment)
      this.diffRendered = true

      this.element.classList.add('markdown-preview-diff')
      this.element.classList.remove('loading')
      this.headingBar.attach()

      this.emitter.emit('did-change-markdown')
      this.element.scrollTop = scrollTop
      this.headingBar.update()
    } catch (error) {
      this.showError(error)
    }
  }

  getTitle() {
    if (this.file != null && this.getPath() != null) {
      return `${path.basename(this.getPath())} Preview`
    } else if (this.editor != null) {
      return `${this.editor.getTitle()} Preview`
    } else {
      return 'Markdown Preview'
    }
  }

  getIconName() {
    return 'markdown'
  }

  getURI() {
    if (this.file != null) {
      return `markdown-preview://${this.getPath()}`
    } else {
      return `markdown-preview://editor/${this.editorId}`
    }
  }

  getPath() {
    if (this.file != null) {
      return this.file.getPath()
    } else if (this.editor != null) {
      return this.editor.getPath()
    }
  }

  getGrammar() {
    return this.editor != null ? this.editor.getGrammar() : undefined
  }

  getDocumentStyleSheets() {
    // This function exists so we can stub it
    return document.styleSheets
  }

  getTextEditorStyles() {
    const textEditorStyles = document.createElement('atom-styles')
    textEditorStyles.initialize(atom.styles)
    textEditorStyles.setAttribute('context', 'atom-text-editor')
    document.body.appendChild(textEditorStyles)

    // Extract style elements content
    return Array.prototype.slice
      .apply(textEditorStyles.childNodes)
      .map(styleElement => styleElement.innerText)
  }

  getMarkdownPreviewCSS() {
    const markdownPreviewRules = []
    const ruleRegExp = /\.markdown-preview/
    const cssUrlRegExp = /url\(atom:\/\/markdown-preview\/assets\/(.*)\)/

    for (const stylesheet of this.getDocumentStyleSheets()) {
      if (stylesheet.rules != null) {
        for (const rule of stylesheet.rules) {
          // We only need `.markdown-review` css
          if (rule.selectorText && rule.selectorText.match(ruleRegExp)) {
            markdownPreviewRules.push(rule.cssText)
          }
        }
      }
    }

    return markdownPreviewRules
      .concat(this.getTextEditorStyles())
      .join('\n')
      .replace(/atom-text-editor/g, 'pre.editor-colors')
      .replace(/:host/g, '.host') // Remove shadow-dom :host selector causing problem on FF
      .replace(cssUrlRegExp, function (_match, assetsName, _offset, _string) {
        // base64 encode assets
        const assetPath = path.join(__dirname, '../assets', assetsName)
        const originalData = fs.readFileSync(assetPath, 'binary')
        const base64Data = Buffer.from(originalData, 'binary').toString(
          'base64'
        )
        return `url('data:image/jpeg;base64,${base64Data}')`
      })
  }

  showError(result) {
    this.element.textContent = ''
    this.element.classList.remove('loading')
    const h2 = document.createElement('h2')
    h2.textContent = 'Previewing Markdown Failed'
    this.element.appendChild(h2)
    if (result) {
      const h3 = document.createElement('h3')
      h3.textContent = result.message
      this.element.appendChild(h3)
    }
  }

  showLoading() {
    this.loading = true
    this.element.classList.add('loading')
  }

  selectAll() {
    if (this.loading) {
      return
    }

    const selection = window.getSelection()
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(this.element)
    selection.addRange(range)
  }

  async copyToClipboard() {
    if (this.loading) {
      return
    }

    const selection = window.getSelection()
    const selectedText = selection.toString()
    const selectedNode = selection.baseNode

    // Use default copy event handler if there is selected text inside this view
    if (
      selectedText &&
      selectedNode != null &&
      (this.element === selectedNode || this.element.contains(selectedNode))
    ) {
      atom.clipboard.write(selectedText)
    } else {
      try {
        const html = await this.getHTML()

        atom.clipboard.write(html)
      } catch (error) {
        atom.notifications.addError('Copying Markdown as HTML failed', {
          dismissable: true,
          detail: error.message
        })
      }
    }
  }

  getSaveDialogOptions() {
    let defaultPath = this.getPath()
    if (defaultPath) {
      defaultPath += '.html'
    } else {
      let projectPath
      defaultPath = 'untitled.md.html'
      if ((projectPath = atom.project.getPaths()[0])) {
        defaultPath = path.join(projectPath, defaultPath)
      }
    }

    return { defaultPath }
  }

  async saveAs(htmlFilePath) {
    if (this.loading) {
      atom.notifications.addWarning(
        'Please wait until the Markdown Preview has finished loading before saving'
      )
      return
    }

    const filePath = this.getPath()
    let title = 'Markdown to HTML'
    if (filePath) {
      title = path.parse(filePath).name
    }

    const htmlBody = await this.getHTML()

    const html =
      `\
<!DOCTYPE html>
<html>
  <head>
      <meta charset="utf-8" />
      <title>${title}</title>
      <style>${this.getMarkdownPreviewCSS()}</style>
  </head>
  <body class='markdown-preview' data-use-github-style="${this.gitHubStyleMode}">${htmlBody}</body>
</html>` + '\n' // Ensure trailing newline

    fs.writeFileSync(htmlFilePath, html)
    return atom.workspace.open(htmlFilePath)
  }
}
