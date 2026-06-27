#!/usr/bin/env node
import { Server } from '@hocuspocus/server'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import chokidar from 'chokidar'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, relative, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FOLDER = resolve(process.argv[2] || '.')
const PORT = parseInt(process.argv[3] || '3000', 10)

// Timestamp of writes we initiated, to suppress chokidar feedback loops
const ownWrites = new Map()
// Debounce timers for disk writes
const pendingWrites = new Map()
// SSE clients for file-tree push
const sseClients = new Set()

function getFileTree(dir, base = dir) {
  try {
    return readdirSync(dir)
      .filter(f => !f.startsWith('.') && f !== 'node_modules')
      .sort()
      .flatMap(name => {
        const full = join(dir, name)
        const rel = relative(base, full)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) {
            return [{ type: 'dir', name, path: rel, children: getFileTree(full, base) }]
          }
          return [{ type: 'file', name, path: rel }]
        } catch { return [] }
      })
  } catch { return [] }
}

function pushFileTree() {
  const payload = `data: ${JSON.stringify(getFileTree(FOLDER))}\n\n`
  for (const res of sseClients) res.write(payload)
}

const hocuspocus = Server.configure({
  async onLoadDocument({ document, documentName }) {
    const filePath = join(FOLDER, documentName)
    // Guard against path traversal
    if (!filePath.startsWith(FOLDER + '/') && filePath !== FOLDER) return document
    if (!existsSync(filePath)) return document
    try {
      const content = readFileSync(filePath, 'utf-8')
      const ytext = document.getText('content')
      if (ytext.length === 0) ytext.insert(0, content)
    } catch (e) {
      console.error('[load]', documentName, e.message)
    }
    return document
  },

  async onChange({ document, documentName }) {
    const filePath = join(FOLDER, documentName)
    if (!filePath.startsWith(FOLDER + '/') && filePath !== FOLDER) return
    const content = document.getText('content').toString()

    clearTimeout(pendingWrites.get(documentName))
    pendingWrites.set(documentName, setTimeout(() => {
      ownWrites.set(filePath, Date.now())
      try {
        writeFileSync(filePath, content, 'utf-8')
      } catch (e) {
        console.error('[write]', documentName, e.message)
      }
      pendingWrites.delete(documentName)
    }, 300))
  },
})

const app = express()
app.use(express.static(join(__dirname, 'public')))

app.get('/api/files', (_req, res) => res.json(getFileTree(FOLDER)))

app.get('/api/watch', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  // Send current tree immediately
  res.write(`data: ${JSON.stringify(getFileTree(FOLDER))}\n\n`)
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

const httpServer = createServer(app)
const wss = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    hocuspocus.handleConnection(ws, request)
  })
})

// Watch for external edits and push them into open Yjs documents
chokidar
  .watch(FOLDER, { ignoreInitial: true, ignored: /(^|[/\\])\.\.?/, ignorePermissionErrors: true })
  .on('add', pushFileTree)
  .on('unlink', pushFileTree)
  .on('addDir', pushFileTree)
  .on('unlinkDir', pushFileTree)
  .on('change', filePath => {
    const lastWrite = ownWrites.get(filePath) || 0
    if (Date.now() - lastWrite < 2000) return // our own write, skip

    const docName = relative(FOLDER, filePath)
    const doc = hocuspocus.documents?.get(docName)
    if (!doc) return

    try {
      const content = readFileSync(filePath, 'utf-8')
      const ytext = doc.getText('content')
      doc.transact(() => {
        ytext.delete(0, ytext.length)
        ytext.insert(0, content)
      })
    } catch (e) {
      console.error('[sync]', filePath, e.message)
    }
  })

httpServer.listen(PORT, () => {
  console.log(`Watching : ${FOLDER}`)
  console.log(`Editor   : http://localhost:${PORT}`)
  console.log('Share the URL with collaborators on the same network.')
})
