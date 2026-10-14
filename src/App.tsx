import { Children, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import './App.css'
import { pingOllama, sendOllamaChat } from './lib/ollama'
import { applyProposalEdits, buildDiff, isWithinProjectRoot, normalizeModelJson, proposalOutputSchema, sanitizePath, validateExistingFileProposal } from './lib/proposal'
import type { ChatRequestMode, CodeChangeProposal, FileNode, Message } from './types'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const PREFERRED_MODEL = 'llama3.2:3b'
const DEFAULT_SYSTEM_PROMPT =
  'You are Local AI, a careful local-first coding assistant. Explain, debug, refactor, and propose changes precisely. Keep answers concise and focused on the selected project and file context. Never execute shell commands or modify files without explicit approval.'

const isTauriRuntime = typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)

function App() {
  const [baseUrl, setBaseUrl] = useState(() => (typeof window !== 'undefined' ? window.localStorage.getItem('local-ai-base-url') ?? DEFAULT_BASE_URL : DEFAULT_BASE_URL))
  const [temperature] = useState(0.2)
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState(() => (typeof window !== 'undefined' ? window.localStorage.getItem('local-ai-model') ?? '' : ''))
  const [projectRoot, setProjectRoot] = useState('')
  const [projectTree, setProjectTree] = useState<FileNode[]>([])
  const browserInputRef = useRef<HTMLInputElement | null>(null)
  const contextInputRef = useRef<HTMLInputElement | null>(null)
  const [browserFileMap, setBrowserFileMap] = useState<Record<string, string>>({})
  const [uploadedContextFiles, setUploadedContextFiles] = useState<{ id: string; name: string; content: string }[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({})
  const [selectedFile, setSelectedFile] = useState('')
  const [selectedFileContent, setSelectedFileContent] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ChatRequestMode>('ask')
  const [proposal, setProposal] = useState<CodeChangeProposal | null>(null)
  const [status, setStatus] = useState('Ready')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('local-ai-base-url', baseUrl)
    }
  }, [baseUrl])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('local-ai-model', selectedModel)
    }
  }, [selectedModel])

  useEffect(() => {
    void refreshModels()
  }, [baseUrl])

  const projectLabel = useMemo(() => {
    if (!projectRoot) return 'No project selected'
    const segments = projectRoot.split(/[\\/]/)
    return segments[segments.length - 1] || projectRoot
  }, [projectRoot])

  const relativeSelectedFile = useMemo(() => {
    if (!selectedFile || !projectRoot) return ''
    const root = projectRoot.replace(/\\/g, '/')
    const path = selectedFile.replace(/\\/g, '/')
    return path.startsWith(root) ? path.slice(root.length + 1) : selectedFile
  }, [projectRoot, selectedFile])

  async function refreshModels() {
    try {
      const names = await pingOllama(baseUrl)
      setModels(names)
      if (!selectedModel || !names.includes(selectedModel)) {
        setSelectedModel(names.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : names[0] ?? '')
      }
      setStatus('Ollama connected')
      setError('')
    } catch (err) {
      setModels([])
      setStatus('Ollama unavailable')
      setError(err instanceof Error ? err.message : 'Unable to reach Ollama.')
    }
  }

  async function handleProjectSelection() {
    if (!isTauriRuntime) {
      if (browserInputRef.current) {
        browserInputRef.current.setAttribute('webkitdirectory', 'true')
        browserInputRef.current.setAttribute('directory', 'true')
      }
      browserInputRef.current?.click()
      return
    }

    try {
      const result = await open({ directory: true, multiple: false, title: 'Select project folder' })
      const nextRoot = typeof result === 'string' ? result : Array.isArray(result) ? result[0] : ''
      if (!nextRoot) {
        return
      }

      const tree = await buildProjectTree(nextRoot)
      setProjectRoot(nextRoot)
      setProjectTree(tree)
      setSelectedFile('')
      setSelectedFileContent('')
      setProposal(null)
      setStatus(`Loaded project: ${nextRoot}`)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open project folder.')
    }
  }

  async function handleBrowserProjectInput(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) {
      return
    }

    const map: Record<string, string> = {}
    const projectName = files[0].webkitRelativePath?.split('/')[0] ?? 'project'
    const rootName = projectName || 'project'

    for (const file of files) {
      const normalized = (file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\.?\//, '')
      const withoutRoot = normalized.startsWith(`${rootName}/`) ? normalized.slice(rootName.length + 1) : normalized
      const prefixed = `${rootName}/${withoutRoot}`
      const text = await file.text()
      map[prefixed] = text
    }

    const tree = buildBrowserTree(rootName, files)
    setProjectRoot(rootName)
    setProjectTree(tree)
    setBrowserFileMap(map)
    setSelectedFile('')
    setSelectedFileContent('')
    setProposal(null)
    setStatus(`Loaded project: ${rootName}`)
    setError('')
    event.target.value = ''
  }

  async function handleContextFileSelection() {
    if (!isTauriRuntime) {
      contextInputRef.current?.click()
      return
    }

    try {
      const result = await open({ multiple: true, title: 'Add files as chat context' })
      const paths = typeof result === 'string' ? [result] : Array.isArray(result) ? result : []
      if (!paths.length) return

      const files = await Promise.all(paths.map(async (path) => ({
        id: crypto.randomUUID(),
        name: path.split(/[\\/]/).pop() ?? path,
        content: await readTextFile(path),
      })))
      setUploadedContextFiles((current) => [...current, ...files])
      setStatus(`Added ${files.length} context file${files.length === 1 ? '' : 's'}`)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read the selected context files.')
    }
  }

  async function handleBrowserContextFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    try {
      const contextFiles = await Promise.all(files.map(async (file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        content: await file.text(),
      })))
      setUploadedContextFiles((current) => [...current, ...contextFiles])
      setStatus(`Added ${contextFiles.length} context file${contextFiles.length === 1 ? '' : 's'}`)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read the selected context files.')
    } finally {
      event.target.value = ''
    }
  }

  function buildUploadedContext() {
    if (!uploadedContextFiles.length) return ''

    let remaining = 12000
    const sections: string[] = []
    for (const file of uploadedContextFiles) {
      if (remaining <= 0) break
      const excerpt = file.content.slice(0, remaining)
      sections.push(`--- ${file.name}${excerpt.length < file.content.length ? ' (truncated)' : ''} ---\n${excerpt}`)
      remaining -= excerpt.length
    }
    return `Additional uploaded file context (read-only; these files are not part of the project and cannot be edited):\n${sections.join('\n\n')}`
  }

  function buildBrowserTree(rootName: string, files: File[]): FileNode[] {
    const paths = files.map((file) => file.webkitRelativePath || file.name)
    return buildBrowserTreeFromPaths(rootName, paths)
  }

  function buildBrowserTreeFromPaths(rootName: string, paths: string[]): FileNode[] {
    const nodes: Record<string, FileNode> = {}

    for (const projectPath of paths) {
      const normalized = projectPath.replace(/\\/g, '/').replace(/^\.?\//, '')
      const withoutRoot = normalized.startsWith(`${rootName}/`) ? normalized.slice(rootName.length + 1) : normalized
      const segments = withoutRoot.split('/').filter(Boolean)
      if (!segments.length) continue
      let currentPath = rootName
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]
        const path = `${currentPath}/${segments.slice(0, index + 1).join('/')}`
        const isFile = index === segments.length - 1

        if (!nodes[path]) {
          nodes[path] = {
            name: segment,
            path,
            kind: isFile ? 'file' : 'dir',
            children: isFile ? undefined : [],
          }
        }

        if (!isFile) {
          const parent = nodes[currentPath]
          if (parent && parent.children) {
            const childExists = parent.children.some((child) => child.path === path)
            if (!childExists) {
              parent.children.push(nodes[path])
            }
          }
        }

        currentPath = path
      }
    }

    const rootNode = nodes[rootName] ?? { name: rootName, path: rootName, kind: 'dir' as const, children: [] }
    if (!rootNode.children) rootNode.children = []

    const children = Object.values(nodes)
      .filter((node) => node.path !== rootName)
      .sort((a, b) => { if (a.kind === b.kind) return a.name.localeCompare(b.name); return a.kind === 'dir' ? -1 : 1 })

    rootNode.children = children.filter((node) => node.path.startsWith(`${rootName}/`))
    return [rootNode]
  }

  async function buildProjectTree(root: string): Promise<FileNode[]> {
    const entries: any[] = await readDir(root)
    const children = await Promise.all(
      entries
        .filter((entry) => !shouldIgnore(entry.name))
        .map(async (entry) => {
          const entryPath = entry.path ?? `${root}/${entry.name}`
          const isDirectory = Boolean(entry.isDirectory || (Array.isArray(entry.children) && entry.children.length > 0) || entry.kind === 'directory')
          const node: FileNode = {
            name: entry.name ?? entryPath.split(/[\\/]/).pop() ?? 'unknown',
            path: entryPath,
            kind: isDirectory ? 'dir' : 'file',
          }

          if (isDirectory) {
            const nested = await buildProjectTree(entryPath)
            node.children = nested
          }

          return node
        }),
    )

    return children.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name)
      return a.kind === 'dir' ? -1 : 1
    })
  }

  function shouldIgnore(name: string) {
    const ignored = [
      '.git',
      '.svn',
      '.idea',
      '.vscode',
      'node_modules',
      'dist',
      'build',
      'coverage',
      '.next',
      '.nuxt',
      '.venv',
      'venv',
      '__pycache__',
      '.pytest_cache',
      '.mypy_cache',
      '.cache',
      '.DS_Store',
    ]
    return ignored.includes(name) || name.startsWith('.') && !['.env.example', '.gitignore'].includes(name)
  }

  async function handleSelectFile(filePath: string) {
    setSelectedFile(filePath)
    try {
      const content = isTauriRuntime ? await readTextFile(filePath) : browserFileMap[filePath] ?? ''
      setSelectedFileContent(content)
      setStatus(`Selected: ${relativePath(filePath)}`)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the selected file.')
    }
  }

  function relativePath(absolutePath: string) {
    if (!projectRoot) return absolutePath
    const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '')
    const full = absolutePath.replace(/\\/g, '/')
    return full.startsWith(root + '/') ? full.slice(root.length + 1) : absolutePath
  }

  function getProjectFiles(nodes: FileNode[]): FileNode[] {
    return nodes.flatMap((node) =>
      node.kind === 'file' ? [node] : getProjectFiles(node.children ?? []),
    )
  }

  async function buildProposalProjectContext() {
    const projectFiles = getProjectFiles(projectTree)
    const allPaths = projectFiles.map((file) => relativePath(file.path))
    const textExtensions = new Set([
      'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx', 'json', 'jsonc',
      'kt', 'md', 'mjs', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'toml', 'ts', 'tsx', 'txt',
      'vue', 'xml', 'yaml', 'yml',
    ])
    const safeToShare = (path: string) =>
      !/(^|\/)(\.env(?!\.example)|[^/]*(secret|credential|private.?key)[^/]*)($|\.)/i.test(path)
    const candidates = projectFiles
      .filter((file) => {
        const path = relativePath(file.path)
        const name = file.name.toLowerCase()
        const extension = name.includes('.') ? name.split('.').pop() ?? '' : ''
        return safeToShare(path) && (
          textExtensions.has(extension) ||
          ['readme', 'license', 'dockerfile', 'makefile', 'justfile'].includes(name)
        )
      })
      .sort((a, b) => {
        const aPath = relativePath(a.path)
        const bPath = relativePath(b.path)
        if (aPath === relativeSelectedFile) return -1
        if (bPath === relativeSelectedFile) return 1
        const aPriority = /^(readme|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt)/i.test(a.name) ? 0 : 1
        const bPriority = /^(readme|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt)/i.test(b.name) ? 0 : 1
        return aPriority - bPriority || aPath.localeCompare(bPath)
      })

    const includedContents: string[] = []
    let contentCharacters = 0
    for (const file of candidates) {
      if (includedContents.length >= 16 || contentCharacters >= 12000) break
      const content = isTauriRuntime ? await readTextFile(file.path) : browserFileMap[file.path]
      if (content === undefined) continue
      const remaining = 12000 - contentCharacters
      const isSelectedFile = relativePath(file.path) === relativeSelectedFile
      const excerpt = content.slice(0, Math.min(isSelectedFile ? 12000 : 2000, remaining))
      includedContents.push(`--- ${relativePath(file.path)}${excerpt.length < content.length ? ' (truncated)' : ''} ---\n${excerpt}`)
      contentCharacters += excerpt.length
    }

    const visiblePaths = allPaths.slice(0, 300)
    return [
      `Selected project: ${projectLabel}`,
      'Existing project files:',
      ...visiblePaths,
      allPaths.length > visiblePaths.length ? `... ${allPaths.length - visiblePaths.length} more files omitted from the list` : '',
      '',
      'Relevant text file contents (credentials, environment files, and binary files are excluded; content may be truncated):',
      ...includedContents,
    ].filter(Boolean).join('\n')
  }

  async function handleSend() {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }
    if (!projectRoot) {
      setError('Select a project directory before sending a request.')
      return
    }
    if (!selectedModel) {
      setError('Choose an Ollama model first.')
      return
    }

    const nextUserMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    }

    const requestMessages: Message[] = [
      { id: 'system', role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      ...messages.filter((item) => item.role !== 'system'),
    ]

    setMessages((current) => [...current, nextUserMessage])
    setDraft('')
    setIsLoading(true)
    setError('')
    setStatus(mode === 'propose' ? 'Generating proposal…' : 'Thinking…')

    try {
      if (mode === 'propose') {
        const projectContext = await buildProposalProjectContext()
        requestMessages.push({
          id: 'project-context',
          role: 'user',
          content: projectContext,
        })
        const uploadedContext = buildUploadedContext()
        if (uploadedContext) {
          requestMessages.push({
            id: 'uploaded-context',
            role: 'user',
            content: uploadedContext,
          })
        }
        requestMessages.push({
          ...nextUserMessage,
          content: `${trimmed}\n\nUse the supplied project tree and source contents to make the requested code change in existing files only. Every change must use operation "replace" and name a file that already appears in the supplied project tree. Never create or delete files. Return each modification as one or more exact, unique old_text/new_text edits; do not return a full file or a partial file as replacement content. Copy every old_text verbatim from the supplied file content, including punctuation and whitespace; do not guess or reconstruct source text. If the relevant source is marked truncated or is not supplied, do not propose an edit for it. Each edit replaces old_text exactly once. Include enough unchanged context in old_text to make each match unique, and preserve that anchor in new_text if it should remain in the file. Make the smallest possible change; do not rewrite unrelated code or duplicate imports, declarations, or definitions. Populate a non-empty summary and description for every change. Paths must match an existing project-relative file path exactly and must not contain '..'. Return no explanation outside the JSON object.`,
        })
      } else {
        const uploadedContext = buildUploadedContext()
        if (uploadedContext) {
          requestMessages.push({
            id: 'uploaded-context',
            role: 'user',
            content: uploadedContext,
          })
        }
        requestMessages.push(nextUserMessage)
        if (selectedFile && selectedFileContent) {
          requestMessages.push({
            id: 'context-file',
            role: 'user',
            content: `Selected file context:\nPath: ${relativePath(selectedFile)}\n\n${selectedFileContent}`,
          })
        }
      }

      const response = await sendOllamaChat(baseUrl, selectedModel, requestMessages, {
        temperature,
        num_ctx: 8192,
        ...(mode === 'propose' ? { format: proposalOutputSchema } : {}),
      })

      if (mode === 'propose') {
        let parsed: unknown
        try {
          parsed = JSON.parse(normalizeModelJson(response))
        } catch {
          throw new Error('The model did not return a valid JSON change proposal. Try again or choose a model that supports JSON output.')
        }
        const existingFiles = getProjectFiles(projectTree)
        const valid = validateExistingFileProposal(
          parsed,
          new Set(existingFiles.map((file) => relativePath(file.path))),
        )
        const changesWithOriginals = await Promise.all(valid.changes.map(async (change) => {
          const file = existingFiles.find((item) => relativePath(item.path) === change.file)
          if (!file) {
            throw new Error(`The proposed file is no longer available in the selected project: ${change.file}`)
          }
          const originalContent = isTauriRuntime ? await readTextFile(file.path) : browserFileMap[file.path]
          if (originalContent === undefined) {
            throw new Error(`Could not read the existing project file: ${change.file}`)
          }
          const edits = change.edits ?? []
          return {
            ...change,
            original_content: originalContent,
            new_content: applyProposalEdits(originalContent, edits),
            expected_hash: await sha256(originalContent),
            selected: true,
          }
        }))
        const reviewedProposal = { ...valid, changes: changesWithOriginals }
        setProposal(reviewedProposal)
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `Review the proposed edits for ${reviewedProposal.summary}.` }])
        setStatus('Proposal ready for review')
      } else {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: response }])
        setStatus('Response received')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The model response could not be processed.')
      setStatus('Request failed')
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: 'I could not complete that request. Please try again or adjust the model or project context.' }])
    } finally {
      setIsLoading(false)
    }
  }

  async function handleApproveProposal() {
    if (!proposal || !projectRoot) {
      return
    }

    const selectedChanges = proposal.changes.filter((change) => change.selected !== false)
    if (!selectedChanges.length) {
      setError('Select at least one proposed change to apply.')
      return
    }

    const backups: Record<string, string> = {}
    const nextBrowserFileMap = { ...browserFileMap }

    try {
      for (const change of selectedChanges) {
        const relativeFile = change.file.replace(/\\/g, '/').trim()
        if (change.operation !== 'replace') {
          throw new Error('Only edits to existing files can be applied from proposal mode.')
        }
        if (!isWithinProjectRoot(projectRoot, relativeFile)) {
          throw new Error(`Unsafe path rejected: ${change.file}`)
        }

        const absolutePath = sanitizePath(projectRoot, relativeFile)
        const fileExists = isTauriRuntime
          ? await exists(absolutePath)
          : Object.prototype.hasOwnProperty.call(nextBrowserFileMap, absolutePath)
        if (!fileExists) {
          throw new Error(`Cannot edit ${change.file}: the file does not exist.`)
        }

        const original = isTauriRuntime
          ? await readTextFile(absolutePath)
          : nextBrowserFileMap[absolutePath]
        const hash = await sha256(original)

        if (change.expected_hash && hash !== change.expected_hash) {
          throw new Error(`File changed since proposal: ${change.file}. Review the diff and retry.`)
        }

        backups[absolutePath] = original

        const nextContent = change.new_content ?? original
        if (isTauriRuntime) {
          await writeTextFile(absolutePath, nextContent)
        } else {
          nextBrowserFileMap[absolutePath] = nextContent
        }
      }

      const refreshedTree = isTauriRuntime
        ? await buildProjectTree(projectRoot)
        : buildBrowserTreeFromPaths(projectRoot, Object.keys(nextBrowserFileMap))
      let refreshedSelectedContent: string | null = null
      if (selectedFile) {
        refreshedSelectedContent = isTauriRuntime
          ? await readTextFile(selectedFile)
          : nextBrowserFileMap[selectedFile] ?? ''
      }

      if (!isTauriRuntime) {
        setBrowserFileMap(nextBrowserFileMap)
      }
      setProjectTree(refreshedTree)
      if (selectedFile) {
        setSelectedFileContent(refreshedSelectedContent ?? '')
      }
      setProposal(null)
      setStatus('Approved changes applied')
      setError('')
      const changedFiles = selectedChanges.map((change) => change.file).join(', ')
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Successfully applied "${proposal.summary}" to ${selectedChanges.length} file${selectedChanges.length === 1 ? '' : 's'}: ${changedFiles}.`,
        },
      ])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to apply the approved changes.'
      setError(message)
      setStatus('Apply failed')
      const undo = Object.entries(backups).reverse()
      for (const [path, previous] of undo) {
        try {
          if (isTauriRuntime) {
            await writeTextFile(path, previous)
          } else {
            nextBrowserFileMap[path] = previous
          }
        } catch (rollbackErr) {
          const rollbackMessage = rollbackErr instanceof Error ? ` ${rollbackErr.message}` : ''
          setError(`${message} Rollback also failed for ${path}.${rollbackMessage}`)
        }
      }
      if (!isTauriRuntime) {
        setBrowserFileMap(nextBrowserFileMap)
      }
    }
  }

  function toggleProposalSelection(file: string) {
    if (!proposal) return
    setProposal({
      ...proposal,
      changes: proposal.changes.map((change) =>
        change.file === file ? { ...change, selected: !(change.selected ?? true) } : change,
      ),
    })
  }

  function handleResetContext() {
    if (proposal && !window.confirm('Discard the current proposal and reset the conversation?')) {
      return
    }
    setMessages([])
    setProposal(null)
    setUploadedContextFiles([])
    setSelectedFile('')
    setSelectedFileContent('')
    setDraft('')
    setStatus('Context reset')
    setError('')
  }

  const renderTree = (nodes: FileNode[], depth = 0) =>
    nodes.map((node) => {
      const key = node.path
      const isExpanded = Boolean(expandedDirs[key])
      const isSelected = selectedFile === node.path

      if (node.kind === 'dir') {
        return (
          <div key={key} className="tree-node tree-node-dir" style={{ paddingLeft: depth * 12 }}>
            <button
              type="button"
              className="tree-toggle"
              onClick={() =>
                setExpandedDirs((current) => ({
                  ...current,
                  [key]: !isExpanded,
                }))
              }
            >
              {isExpanded ? '▾' : '▸'} {node.name}
            </button>
            {isExpanded && node.children && renderTree(node.children, depth + 1)}
          </div>
        )
      }

      return (
        <button
          key={key}
          type="button"
          className={`tree-node tree-node-file ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 12 + 16 }}
          onClick={() => handleSelectFile(node.path)}
        >
          {node.name}
        </button>
      )
    })

  return (
    <>
      <input
        ref={browserInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleBrowserProjectInput}
      />
      <input
        ref={contextInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleBrowserContextFiles}
      />
      <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="logo">L</div>
          <div>
            <div className="brand-name">Local AI</div>
            <div className="brand-subtitle">Coding assistant</div>
          </div>
        </div>

        <button type="button" className="primary-button" onClick={() => setMessages([])}>
          New Chat
        </button>

        <div className="sidebar-section">
          <div className="sidebar-label">Current project</div>
          <div className="project-name">{projectLabel}</div>
          <button type="button" className="secondary-button" onClick={handleProjectSelection}>
            Select Project Folder
          </button>
          <button type="button" className="secondary-button" onClick={() => void handleContextFileSelection()}>
            Upload Context Files
          </button>
          {uploadedContextFiles.map((file) => (
            <div key={file.id} className="selected-file-bar">
              <span>{file.name}</span>
              <button
                type="button"
                className="inline-button"
                onClick={() => setUploadedContextFiles((current) => current.filter((item) => item.id !== file.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-section file-panel">
          <div className="sidebar-label">Project files</div>
          {projectRoot ? renderTree(projectTree) : <div className="empty-text">No folder selected</div>}
        </div>
      </aside>

      <main className="main-panel">
        <header className="chat-header">
          <div>
            <strong>Workspace</strong>
            <span>{projectRoot ? ` • ${relativePath(projectRoot)}` : ' • Local project'}</span>
          </div>
          <div className="status-inline">
            <span className={`status-dot ${error ? 'error' : ''}`}></span>
            {status}
          </div>
        </header>

        <section className="chat-body">
          {messages.length === 0 && !proposal && (
            <div className="empty-state">
              <h1>Start a new coding task.</h1>
              <p>Select a local project and ask the model to explain, fix, refactor, or propose code changes.</p>
            </div>
          )}

          {messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              {message.role === 'assistant' ? (
                <div className="message-content markdown-body">
                  <ReactMarkdown
                    components={{
                    p({ children }) {
                      const childArray = Children.toArray(children)
                      const containsBlock = childArray.some((child) => {
                        return typeof child === 'object' && child !== null && 'type' in child && child.type === 'pre'
                      })
                      return containsBlock ? <>{children}</> : <p>{children}</p>
                    },
                    code({ className, children, ...props }) {
                      const codeText = String(children)
                      const inline = Boolean((props as { inline?: boolean }).inline)

                      if (inline) {
                        return <code className={className} {...props}>{codeText}</code>
                      }

                      return (
                        <pre className="code-block">
                          <code className={className} {...props}>
                            {codeText}
                          </code>
                          <button type="button" className="copy-button" onClick={() => navigator.clipboard.writeText(codeText)}>
                            Copy
                          </button>
                        </pre>
                      )
                    },
                  }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="message-content user-message">{message.content}</div>
              )}
            </div>
          ))}

          {proposal && (
            <div className="proposal-panel">
              <div className="proposal-header">
                <div>
                  <strong>Change proposal</strong>
                  <div>{proposal.summary}</div>
                </div>
                <button type="button" className="secondary-button" onClick={() => navigator.clipboard.writeText(JSON.stringify(proposal, null, 2))}>
                  Copy JSON
                </button>
              </div>

              {proposal.changes.map((change) => (
                <div key={`${change.file}-${change.operation}`} className="proposal-change">
                  <label className="proposal-toggle">
                    <input
                      type="checkbox"
                      checked={change.selected ?? true}
                      onChange={() => toggleProposalSelection(change.file)}
                    />
                    <span>{change.operation.toUpperCase()} • {change.file}</span>
                  </label>
                  <div className="proposal-meta">{change.description}</div>

                  <div className="diff-grid">
                    <div>
                      <h4>Original</h4>
                      <pre>{change.original_content ?? 'New file'}</pre>
                    </div>
                    <div>
                      <h4>Proposed</h4>
                      <pre>{change.new_content ?? 'Deleted file'}</pre>
                    </div>
                  </div>

                  <div className="diff-lines">
                    {buildDiff(change.original_content ?? '', change.new_content ?? '').map((line, index) => (
                      <div key={`${change.file}-${index}`} className={`diff-line ${line.type}`}>
                        <span>{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>
                        <span>{line.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="proposal-actions">
                <button type="button" className="primary-button" onClick={handleApproveProposal}>
                  Approve & Apply
                </button>
                <button type="button" className="secondary-button" onClick={() => setProposal(null)}>
                  Reject
                </button>
              </div>
            </div>
          )}

          {isLoading && <div className="loading-indicator">Generating…</div>}
        </section>

        <footer className="composer-panel">
          <div className="composer-toolbar">
            <div className="context-inline">
              <label>
                Mode
                <select value={mode} onChange={(event) => setMode(event.target.value as ChatRequestMode)}>
                  <option value="ask">Ask</option>
                  <option value="propose">Propose Changes</option>
                </select>
              </label>

              <label>
                Model
                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                  <option value="">Select a model</option>
                  {models.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </label>

              <label>
                Base URL
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </label>

              <button type="button" className="secondary-button" onClick={() => void refreshModels()}>
                Refresh models
              </button>
            </div>

            <button type="button" className="secondary-button" onClick={handleResetContext}>
              Reset Context
            </button>
          </div>

          <div className="selected-file-bar">
            {selectedFile ? (
              <>
                <span>Selected file</span>
                <strong>{relativeSelectedFile}</strong>
                <button type="button" className="inline-button" onClick={() => setSelectedFile('')}>Remove</button>
              </>
            ) : (
              <span>No file selected</span>
            )}
          </div>

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            placeholder={mode === 'propose' ? 'Ask the AI to edit existing project files and return a JSON proposal…' : 'Ask the assistant to explain, debug, or improve the selected project…'}
          />

          <div className="composer-actions">
            <button type="button" className="secondary-button" onClick={() => setDraft('')}>
              Clear
            </button>
            <button type="button" className="primary-button" onClick={() => void handleSend()} disabled={isLoading || !selectedModel}>
              {isLoading ? 'Generating…' : mode === 'propose' ? 'Propose Changes' : 'Send'}
            </button>
          </div>

          {error && <div className="error-banner">{error}</div>}
        </footer>
      </main>
      </div>
    </>
  )
}

async function sha256(value: string) {
  const buffer = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export default App
