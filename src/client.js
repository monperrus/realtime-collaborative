import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'

const USER_COLORS = [
  '#e57373', '#81c784', '#64b5f6', '#ffb74d',
  '#ba68c8', '#4dd0e1', '#aed581', '#f06292',
]
const userColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
const userName = `User ${Math.floor(Math.random() * 900 + 100)}`

let currentProvider = null
let currentView = null
let currentDoc = null

function langExtension(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  if (['js', 'mjs', 'cjs'].includes(ext)) return javascript()
  if (['ts'].includes(ext)) return javascript({ typescript: true })
  if (['jsx', 'tsx'].includes(ext)) return javascript({ jsx: true, typescript: ext === 'tsx' })
  if (ext === 'py') return python()
  if (['md', 'mdx'].includes(ext)) return markdown()
  if (['html', 'htm'].includes(ext)) return html()
  if (ext === 'css') return css()
  if (ext === 'json') return json()
  return []
}

function openFile(path) {
  // Tear down previous session
  if (currentProvider) { currentProvider.destroy(); currentProvider = null }
  if (currentView) { currentView.destroy(); currentView = null }
  if (currentDoc) { currentDoc.destroy(); currentDoc = null }

  document.getElementById('toolbar').textContent = path
  document.getElementById('editor').innerHTML = ''

  const ydoc = new Y.Doc()
  currentDoc = ydoc

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
  const provider = new WebsocketProvider(`${wsProto}://${location.host}`, path, ydoc)
  currentProvider = provider

  provider.awareness.setLocalStateField('user', { name: userName, color: userColor })

  const ytext = ydoc.getText('content')
  const undoManager = new Y.UndoManager(ytext)

  const state = EditorState.create({
    extensions: [
      basicSetup,
      keymap.of(yUndoManagerKeymap),
      langExtension(path),
      yCollab(ytext, provider.awareness, { undoManager }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
    ],
  })

  currentView = new EditorView({
    state,
    parent: document.getElementById('editor'),
  })

  // Mark active in tree
  document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'))
  document.querySelector(`.file-item[data-path="${CSS.escape(path)}"]`)?.classList.add('active')
}

function renderTree(nodes, container, depth = 0) {
  container.innerHTML = ''
  for (const node of nodes) {
    if (node.type === 'dir') {
      const toggle = document.createElement('div')
      toggle.className = 'dir-item'
      toggle.style.paddingLeft = `${depth * 12}px`
      toggle.textContent = `▸ ${node.name}`
      container.appendChild(toggle)

      const children = document.createElement('div')
      children.className = 'dir-children'
      renderTree(node.children, children, depth + 1)
      container.appendChild(children)

      let open = true
      toggle.addEventListener('click', () => {
        open = !open
        children.style.display = open ? '' : 'none'
        toggle.textContent = `${open ? '▾' : '▸'} ${node.name}`
      })
    } else {
      const item = document.createElement('div')
      item.className = 'file-item'
      item.style.paddingLeft = `${depth * 12 + 14}px`
      item.textContent = node.name
      item.dataset.path = node.path
      item.addEventListener('click', () => openFile(node.path))
      container.appendChild(item)
    }
  }
}

// SSE for live file-tree updates
const events = new EventSource('/api/watch')
events.onmessage = e => {
  const tree = JSON.parse(e.data)
  renderTree(tree, document.getElementById('file-tree'))
}
events.onerror = () => {
  // SSE will auto-reconnect; nothing to do
}
