const path = require('path')
const fs = require('fs-plus')
const { CompositeDisposable } = require('atom')

// Extensions that open as a preview by default (excludes `txt`, which the
// tree-view command allows but which is too broad for default-open behavior).
const PREVIEW_EXTENSIONS = ['markdown', 'md', 'mdown', 'mkd', 'mkdown', 'ron']

let MarkdownPreviewView = null
let renderer = null

const isMarkdownPreviewView = function (object) {
  if (MarkdownPreviewView == null) {
    MarkdownPreviewView = require('./markdown-preview-view')
  }
  return object instanceof MarkdownPreviewView
}

module.exports = {
  activate() {
    this.disposables = new CompositeDisposable()
    this.commandSubscriptions = new CompositeDisposable()

    this.style = new CSSStyleSheet()

    // TODO: When we upgrade Electron, we can push onto `adoptedStyleSheets`
    // directly. For now, we have to do this silly thing.
    let styleSheets = Array.from(document.adoptedStyleSheets ?? [])
    styleSheets.push(this.style)
    document.adoptedStyleSheets = styleSheets

    this.disposables.add(
      atom.config.observe('markdown-preview.grammars', grammars => {
        this.commandSubscriptions.dispose()
        this.commandSubscriptions = new CompositeDisposable()

        if (grammars == null) {
          grammars = []
        }

        for (const grammar of grammars.map(grammar =>
          grammar.replace(/\./g, ' ')
        )) {
          this.commandSubscriptions.add(
            atom.commands.add(`atom-text-editor[data-grammar='${grammar}']`, {
              'markdown-preview:toggle': () => this.toggle(),
              'markdown-preview:copy-html': {
                displayName: 'Markdown Preview: Copy HTML',
                didDispatch: () => this.copyHTML()
              },
              'markdown-preview:save-as-html': {
                displayName: 'Markdown Preview: Save as HTML',
                didDispatch: () => this.saveAsHTML()
              },
              'markdown-preview:toggle-break-on-single-newline': () => {
                const keyPath = 'markdown-preview.breakOnSingleNewline'
                atom.config.set(keyPath, !atom.config.get(keyPath))
              },
              'markdown-preview:toggle-github-style': () => {
                const keyPath = 'markdown-preview.useGitHubStyle'
                atom.config.set(keyPath, !atom.config.get(keyPath))
              }
            })
          )
        }
      })
    )

    this.disposables.add(
      atom.config.observe('editor.fontFamily', (fontFamily) => {
        // Keep the user's `fontFamily` setting in sync with preview styles.
        // `pre` blocks will use this font automatically, but `code` elements
        // need a specific style rule.
        //
        // Since this applies to all content, we should declare this only once,
        // instead of once per preview view.
        this.style.replaceSync(`
          .markdown-preview code {
            font-family: ${fontFamily} !important;
          }
        `)
      })
    )

    // Allow toggling back to the editable source while a preview is focused
    // (the grammar-scoped `atom-text-editor` command above doesn't match here).
    this.disposables.add(
      atom.commands.add('.markdown-preview', {
        'markdown-preview:toggle': () => this.toggle()
      })
    )

    const previewFile = this.previewFile.bind(this)
    for (const extension of [
      'markdown',
      'md',
      'mdown',
      'mkd',
      'mkdown',
      'ron',
      'txt'
    ]) {
      this.disposables.add(
        atom.commands.add(
          `.tree-view .file .name[data-name$=\\.${extension}]`,
          'markdown-preview:preview-file',
          previewFile
        )
      )
    }

    this.disposables.add(
      atom.workspace.addOpener(uriToOpen => {
        let [protocol, path] = uriToOpen.split('://')
        if (protocol !== 'markdown-preview') {
          return
        }

        try {
          path = decodeURI(path)
        } catch (error) {
          return
        }

        if (path.startsWith('editor/')) {
          return this.createMarkdownPreviewView({ editorId: path.substring(7) })
        } else {
          return this.createMarkdownPreviewView({ filePath: path })
        }
      })
    )

    // Default-open: intercept opening a Markdown *file* and show the preview
    // instead of the editor. `openingSource` is the escape hatch — set while we
    // deliberately open the editable buffer (see `openSource`).
    this.disposables.add(
      atom.workspace.addOpener(uriToOpen => {
        if (!atom.config.get('markdown-preview.openInPreviewByDefault')) {
          return
        }
        if (this.openingSource) {
          return
        }
        if (uriToOpen.includes('://')) {
          return
        }
        const ext = path.extname(uriToOpen).replace(/^\./, '').toLowerCase()
        if (!PREVIEW_EXTENSIONS.includes(ext)) {
          return
        }
        return this.createMarkdownPreviewView({ filePath: uriToOpen })
      })
    )
  },

  deactivate() {
    this.disposables.dispose()
    this.commandSubscriptions.dispose()
  },

  createMarkdownPreviewView(state) {
    if (state.editorId || fs.isFileSync(state.filePath)) {
      if (MarkdownPreviewView == null) {
        MarkdownPreviewView = require('./markdown-preview-view')
      }
      return new MarkdownPreviewView(state)
    }
  },

  toggle() {
    // From a preview: switch to the editable source in the same pane.
    const activeItem = atom.workspace.getActivePaneItem()
    if (isMarkdownPreviewView(activeItem)) {
      return this.openSource(activeItem.getPath())
    }

    const editor = atom.workspace.getActiveTextEditor()
    if (editor == null) {
      return
    }

    const grammars = atom.config.get('markdown-preview.grammars') || []
    if (!grammars.includes(editor.getGrammar().scopeName)) {
      return
    }

    // From an editor: switch to its preview in the same pane (activated).
    // Jumps to an existing preview if one is already open.
    return atom.workspace.open(this.uriForEditor(editor), {
      searchAllPanes: true
    })
  },

  // Open the editable source buffer for `filePath`, bypassing the
  // default-preview opener so we actually get the editor.
  openSource(filePath) {
    if (!filePath) {
      return
    }
    this.openingSource = true
    return Promise.resolve(
      atom.workspace.open(filePath, { searchAllPanes: true })
    ).finally(() => {
      this.openingSource = false
    })
  },

  uriForEditor(editor) {
    return `markdown-preview://editor/${editor.id}`
  },

  removePreviewForEditor(editor) {
    const uri = this.uriForEditor(editor)
    const previewPane = atom.workspace.paneForURI(uri)
    if (previewPane != null) {
      previewPane.destroyItem(previewPane.itemForURI(uri))
      return true
    } else {
      return false
    }
  },

  addPreviewForEditor(editor) {
    const uri = this.uriForEditor(editor)
    const previousActivePane = atom.workspace.getActivePane()
    const options = { searchAllPanes: true }
    if (atom.config.get('markdown-preview.openPreviewInSplitPane')) {
      options.split = 'right'
    }

    return atom.workspace
      .open(uri, options)
      .then(function (markdownPreviewView) {
        if (isMarkdownPreviewView(markdownPreviewView)) {
          previousActivePane.activate()
        }
      })
  },

  previewFile({ target }) {
    const filePath = target.dataset.path
    if (!filePath) {
      return
    }

    for (const editor of atom.workspace.getTextEditors()) {
      if (editor.getPath() === filePath) {
        return this.addPreviewForEditor(editor)
      }
    }

    atom.workspace.open(`markdown-preview://${encodeURI(filePath)}`, {
      searchAllPanes: true
    })
  },

  async copyHTML() {
    const editor = atom.workspace.getActiveTextEditor()
    if (editor == null) {
      return
    }

    if (renderer == null) {
      renderer = require('./renderer')
    }
    const text = editor.getSelectedText() || editor.getText()
    const html = await renderer.toHTML(
      text,
      editor.getPath(),
      editor.getGrammar(),
      editor.id
    )

    atom.clipboard.write(html)
  },

  saveAsHTML() {
    const activePaneItem = atom.workspace.getActivePaneItem()
    if (isMarkdownPreviewView(activePaneItem)) {
      atom.workspace.getActivePane().saveItemAs(activePaneItem)
      return
    }

    const editor = atom.workspace.getActiveTextEditor()
    if (editor == null) {
      return
    }

    const grammars = atom.config.get('markdown-preview.grammars') || []
    if (!grammars.includes(editor.getGrammar().scopeName)) {
      return
    }

    const uri = this.uriForEditor(editor)
    const markdownPreviewPane = atom.workspace.paneForURI(uri)
    const markdownPreviewPaneItem =
      markdownPreviewPane != null
        ? markdownPreviewPane.itemForURI(uri)
        : undefined

    if (isMarkdownPreviewView(markdownPreviewPaneItem)) {
      return markdownPreviewPane.saveItemAs(markdownPreviewPaneItem)
    }
  }
}
