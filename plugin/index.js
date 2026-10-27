/**
 * Xcode Pilot — a DeepSeek Harness Host plugin for driving Xcode.
 *
 * It keeps one official Xcode MCP bridge (`xcrun mcpbridge`) alive, exposes a
 * small curated set of model-facing tools over it, and uses Apple's `simctl`
 * for simulator management. No private Xcode APIs, project-file rewriting, or
 * UI scripting.
 *
 * @module dsh-xcode
 */

import { access, mkdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const name = 'dsh-xcode'
export const inject = ['tools', 'subprocess']

const MCP_PROTOCOL = '2025-06-18'
const XCRUN = process.env.DSH_XCODE_XCRUN || '/usr/bin/xcrun'
const HOMEDIR = homedir()
const MCP_START_TIMEOUT_MS = envInt('DSH_XCODE_START_TIMEOUT_MS', 45_000)
const BUILD_TIMEOUT_MS = envInt('DSH_XCODE_BUILD_TIMEOUT_MS', 30 * 60_000)
const TEST_TIMEOUT_MS = envInt('DSH_XCODE_TEST_TIMEOUT_MS', 30 * 60_000)
const RUN_TIMEOUT_MS = envInt('DSH_XCODE_RUN_TIMEOUT_MS', 10 * 60_000)
const MAX_ISSUES = 80
const MAX_TEXT = 16_000

function envInt(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function clip(text, max = 800) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function contentText(result) {
  if (!result || !Array.isArray(result.content)) return ''
  return result.content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      if (block.type === 'resource' && typeof block.resource?.text === 'string') return block.resource.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function mcpValue(result) {
  if (result && result.structuredContent != null) return result.structuredContent
  const text = contentText(result)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function approvalHint(message) {
  if (/isn't approved|not approved|approve this agent/i.test(message)) {
    return 'Xcode has not approved this agent yet. Open the project with xcode_context action="open"; when Xcode asks, choose Allow (and allow access to the project folder), then retry.'
  }
  if (/workspaceIdentifier is required|open workspace|no open workspace/i.test(message)) {
    return 'No Xcode workspace is open. Use xcode_context action="open" with an absolute .xcodeproj or .xcworkspace path first.'
  }
  if (/No running Xcode|Could not determine the parent Xcode|Could not connect to Xcode|not running/i.test(message)) {
    return 'Xcode is not running or its MCP service is unavailable. Launch Xcode, open the project, then retry.'
  }
  if (/Model Context Protocol|external agents/i.test(message)) {
    return 'Enable Xcode > Settings > Intelligence > "Allow external agents to use Xcode tools", then retry.'
  }
  return null
}

class XcodeMCPError extends Error {
  constructor(message, options = {}) {
    const hint = options.hint ?? approvalHint(message)
    super(hint && !message.includes(hint) ? `${message}\n\n${hint}` : message)
    this.name = 'XcodeMCPError'
    this.hint = hint ?? undefined
  }
}

/**
 * One long-lived JSON-RPC client for the official Xcode MCP bridge.
 * Newline-delimited MCP framing; requests are correlated by id.
 */
class XcodeMCP {
  constructor(ctx) {
    this.ctx = ctx
    this.handle = null
    this.starting = null
    this.ready = false
    this.closed = false
    this.seq = 0
    this.pending = new Map()
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.stderr = ''
    this.serverInfo = undefined
    this.stderrTruncated = false
    this.queue = Promise.resolve()
  }

  /**
   * Xcode's tool service is stateful (active scheme/destination, one build
   * stream, one launch session). Serialize operations that target it so a
   * parallel status/inspect call cannot sit on the same bridge while a build
   * is in flight or make the official server drop a correlated response.
   */
  serialize(operation) {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  statusLine() {
    if (this.ready) {
      const info = this.serverInfo
      return info ? `${info.name} ${info.version}` : 'connected'
    }
    return this.handle ? 'starting' : 'disconnected'
  }

  async ensure(signal) {
    if (this.closed) throw new XcodeMCPError('The Xcode plugin is unloading.')
    if (this.ready && this.handle) return this.serverInfo
    if (!this.starting) {
      this.starting = this.launch(signal).finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  async launch(signal) {
    this.spawnBridge()
    try {
      const result = await this.requestRaw(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'dsh-xcode', version: '0.1.0' },
        },
        { timeoutMs: MCP_START_TIMEOUT_MS, signal },
      )
      this.serverInfo = result?.serverInfo
      this.write({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })
      this.ready = true
      return this.serverInfo
    } catch (error) {
      this.terminate(
        error instanceof Error ? error.message : 'Xcode MCP initialization failed.',
      )
      throw error
    }
  }

  spawnBridge() {
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.stderr = ''
    this.stderrTruncated = false
    const handle = this.ctx.subprocess.spawn({
      argv: [XCRUN, 'mcpbridge'],
      cwd: HOMEDIR,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: 2_000,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    })
    this.handle = handle
    this.ready = false

    handle.stdout?.on('data', (chunk) => {
      if (this.handle !== handle) return
      this.buffer += this.decoder.write(chunk)
      this.drainLines()
    })
    handle.stdout?.on('end', () => {
      if (this.handle !== handle) return
      this.buffer += this.decoder.end()
      this.drainLines()
    })
    handle.stderr?.on('data', (chunk) => {
      if (this.handle !== handle) return
      const text = chunk.toString()
      this.stderr = `${this.stderr}${text}`.slice(-8_000)
      if (this.stderr.length >= 8_000) this.stderrTruncated = true
    })
    handle.done.then(
      (outcome) => {
        if (this.handle !== handle) return
        this.handle = null
        this.ready = false
        const suffix = this.stderr.trim() ? `\n${clip(this.stderr.trim(), 2_000)}` : ''
        const reason = `Xcode MCP bridge exited (${outcome.exitCode ?? outcome.signal ?? 'unknown'})${suffix}`
        this.rejectAll(new XcodeMCPError(reason))
      },
      (error) => {
        if (this.handle !== handle) return
        this.handle = null
        this.ready = false
        this.rejectAll(
          new XcodeMCPError(
            `Xcode MCP bridge failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      },
    )
  }

  drainLines() {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.handleMessage(message)
    }
    if (this.buffer.length > 2_000_000) this.buffer = ''
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      pending.cleanup()
      if (message.error) {
        pending.reject(
          new XcodeMCPError(
            `Xcode MCP error: ${message.error.message ?? JSON.stringify(message.error)}`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    // Notifications (progress, tools/list_changed, cancelled) need no action.
  }

  requestRaw(method, params, { timeoutMs = 60_000, signal } = {}) {
    if (!this.handle) {
      return Promise.reject(new XcodeMCPError('Xcode MCP bridge is not running.'))
    }
    if (signal?.aborted) {
      return Promise.reject(new XcodeMCPError('Xcode operation cancelled.'))
    }
    const id = ++this.seq
    return new Promise((resolvePromise, rejectPromise) => {
      let timer
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        cleanup()
        try {
          this.write({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'Harness tool call cancelled' },
          })
        } catch {
          // The bridge may already be gone.
        }
        this.terminate('Xcode operation cancelled.')
        rejectPromise(new XcodeMCPError('Xcode operation cancelled.'))
      }
      timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        cleanup()
        this.terminate(`Xcode MCP request timed out after ${Math.round(timeoutMs / 1000)}s.`)
        rejectPromise(
          new XcodeMCPError(
            `Xcode did not respond within ${Math.round(timeoutMs / 1000)}s. The operation was cancelled and the MCP bridge will reconnect on the next call.`,
          ),
        )
      }, timeoutMs)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, cleanup })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        rejectPromise(
          error instanceof Error ? error : new XcodeMCPError(`Could not write to Xcode MCP: ${String(error)}`),
        )
      }
    })
  }

  write(message) {
    const stdin = this.handle?.stdin
    if (!stdin || stdin.destroyed) throw new XcodeMCPError('Xcode MCP bridge is not running.')
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  async callTool(name, args = {}, { timeoutMs = 60_000, signal } = {}) {
    await this.ensure(signal)
    const result = await this.requestRaw(
      'tools/call',
      { name, arguments: args },
      { timeoutMs, signal },
    )
    if (result?.isError) {
      const message = contentText(result) || `${name} failed inside Xcode.`
      throw new XcodeMCPError(message)
    }
    return mcpValue(result)
  }

  rejectAll(error) {
    for (const [, pending] of this.pending) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
  }

  terminate(reason) {
    const handle = this.handle
    this.handle = null
    this.ready = false
    this.rejectAll(new XcodeMCPError(reason))
    try {
      handle?.terminate()
    } catch {
      // Already gone.
    }
  }

  async close() {
    this.closed = true
    const handle = this.handle
    this.handle = null
    this.ready = false
    this.rejectAll(new XcodeMCPError('The Xcode plugin is unloading.'))
    try {
      handle?.terminate()
    } catch {
      // Already gone.
    }
    if (handle) {
      await Promise.race([
        handle.done.catch(() => undefined),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
      ])
    }
  }
}

function parseWorkspaces(value) {
  const found = new Map()
  const add = (id, path) => {
    const cleanId = String(id ?? '').trim()
    if (!cleanId || found.has(cleanId)) return
    found.set(cleanId, { id: cleanId, path: String(path ?? '').trim() || null })
  }
  if (Array.isArray(value?.workspaces)) {
    for (const workspace of value.workspaces) add(workspace?.id ?? workspace?.workspaceIdentifier, workspace?.path ?? workspace?.workspacePath)
  }
  const message = typeof value === 'string' ? value : value?.message
  if (typeof message === 'string') {
    const pattern = /workspaceIdentifier:\s*([^,\s]+),\s*workspacePath:\s*(.+?)(?:\n|$)/g
    for (const match of message.matchAll(pattern)) add(match[1], match[2])
  }
  return [...found.values()]
}

function formatWorkspace(workspace) {
  return workspace.path ? `${workspace.id}  ${workspace.path}` : workspace.id
}

async function resolveWorkspace(mcp, args, signal) {
  const requested = typeof args.workspace === 'string' ? args.workspace.trim() : ''
  if (requested) {
    const looksLikePath =
      isAbsolute(requested) ||
      requested.includes('/') ||
      /\.(xcodeproj|xcworkspace)$/i.test(requested)
    if (looksLikePath) {
      if (!isAbsolute(requested)) {
        throw new Error('workspace must be an absolute path to an .xcodeproj or .xcworkspace.')
      }
      const projectPath = resolve(requested)
      let info
      try {
        info = await stat(projectPath)
      } catch {
        throw new Error(`Xcode project not found: ${projectPath}`)
      }
      if (!info.isDirectory()) throw new Error(`Not an Xcode project directory: ${projectPath}`)
      if (!/\.(xcodeproj|xcworkspace)$/i.test(projectPath)) {
        throw new Error(`Expected an .xcodeproj or .xcworkspace directory: ${projectPath}`)
      }
      const opened = await mcp.callTool(
        'XcodeOpenWorkspace',
        { path: projectPath },
        { timeoutMs: 180_000, signal },
      )
      return {
        id: opened.workspaceIdentifier,
        path: opened.workspacePath || projectPath,
        opened,
      }
    }
    return { id: requested, path: null }
  }

  const listed = await mcp.callTool('XcodeListWorkspaces', {}, { timeoutMs: 60_000, signal })
  const workspaces = parseWorkspaces(listed)
  if (workspaces.length === 0) {
    throw new Error(
      'No Xcode workspace is open. Use xcode_context with action="open" and an absolute .xcodeproj or .xcworkspace path first.',
    )
  }
  if (workspaces.length > 1) {
    throw new Error(
      `Multiple Xcode workspaces are open. Pass workspace=<identifier or absolute path> to choose one:\n${workspaces
        .map((workspace) => `- ${formatWorkspace(workspace)}`)
        .join('\n')}`,
    )
  }
  return workspaces[0]
}

function workspaceHeader(workspace) {
  return workspace.path ? workspace.path : workspace.id
}

/**
 * Xcode's preview and project-file tools address files in Xcode's project
 * organization, not on the filesystem. Convert an absolute path under the
 * project container to that organization-relative form; pass a relative path
 * through unchanged.
 */
function projectRelativePath(file, workspace) {
  if (!isAbsolute(file)) return file
  if (!workspace.path || !/\.(xcodeproj|xcworkspace)$/i.test(workspace.path)) return file
  const root = dirname(workspace.path)
  const rel = relative(root, file)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file
}

function formatIssue(issue) {
  const location = issue.filePath
    ? `${issue.filePath}${issue.lineNumber ? `:${issue.lineNumber}` : ''}`
    : ''
  const severity = issue.severity ? `[${issue.severity}] ` : ''
  return `${location ? `${location}: ` : ''}${severity}${clip(issue.message, 600)}`
}

function dedupeIssues(issues) {
  const seen = new Set()
  const result = []
  for (const issue of issues) {
    const key = `${issue.severity ?? ''}|${issue.filePath ?? ''}|${issue.lineNumber ?? ''}|${issue.message ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(issue)
  }
  return result
}

async function runCommand(ctx, argv, exec, { timeoutMs = 60_000, cwd = HOMEDIR, maxBytes = 4_000_000 } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  if (exec.signal) exec.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes, spill: { maxBytes: maxBytes * 2 } },
        stderr: { maxBytes: 200_000, spill: { maxBytes: 400_000 } },
      },
      graceMs: 2_000,
      signal: controller.signal,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      },
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
    if (timedOut) {
      throw new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.join(' ')}`)
    }
    if (controller.signal.aborted) throw new Error('Command cancelled.')
    if (outcome.exitCode !== 0) {
      const detail = (stderr || stdout).trim()
      throw new Error(
        `Command failed (exit ${outcome.exitCode ?? outcome.signal ?? 'unknown'}): ${argv.join(' ')}${detail ? `\n${clip(detail, 4_000)}` : ''}`,
      )
    }
    return { stdout, stderr, exitCode: outcome.exitCode }
  } finally {
    clearTimeout(timer)
    if (exec.signal) exec.signal.removeEventListener('abort', onAbort)
  }
}

async function simctl(ctx, exec, argv, options = {}) {
  return runCommand(ctx, [XCRUN, 'simctl', ...argv], exec, options)
}

function simulatorDevices(value) {
  const devices = []
  for (const [runtime, group] of Object.entries(value?.devices ?? {})) {
    for (const device of group) {
      if (device?.isAvailable === false) continue
      devices.push({
        name: device.name,
        udid: device.udid,
        state: device.state,
        runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, ' '),
      })
    }
  }
  return devices
}

function simulatorSummary(devices) {
  if (devices.length === 0) {
    return 'No available simulators. Install a Simulator runtime from Xcode > Settings > Components, then retry.'
  }
  const lines = [`Available simulators (${devices.length}):`]
  for (const device of devices.slice(0, 40)) {
    lines.push(`- ${device.name} · ${device.runtime} · ${device.state} · ${device.udid}`)
  }
  if (devices.length > 40) lines.push(`… ${devices.length - 40} more`)
  return lines.join('\n')
}

/** JSON Schema types accepted in model-facing tool parameters. */
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

/**
 * Convert the terse authoring form used below into raw JSON Schema: nested
 * `required: true` markers become a per-object `required` array, and the
 * marker itself never reaches the wire.
 *
 * The object check comes first so an object property that is itself required
 * keeps the `required` array it just hoisted from its children.
 */
function toStandardJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toStandardJsonSchema)
  if (!node || typeof node !== 'object') return node
  const authoredRequired = node.required === true || node.required === false
  const result = { ...node }
  if (authoredRequired) delete result.required
  if (result.properties && typeof result.properties === 'object') {
    const required = Array.isArray(result.required) ? [...result.required] : []
    const properties = {}
    for (const [key, raw] of Object.entries(result.properties)) {
      if (raw && raw.required === true && !required.includes(key)) required.push(key)
      properties[key] = toStandardJsonSchema(raw)
    }
    result.properties = properties
    if (required.length) result.required = required
    else delete result.required
  }
  if (result.items) result.items = toStandardJsonSchema(result.items)
  if (Array.isArray(result.oneOf)) result.oneOf = result.oneOf.map(toStandardJsonSchema)
  return result
}

function outputSchema(properties) {
  return toStandardJsonSchema({
    type: 'object',
    additionalProperties: false,
    properties,
  })
}

/**
 * Compile a parameter property map into the raw, object-rooted JSON Schema that
 * `ctx.tools.register` requires. Registration forwards `parameters` verbatim
 * to the model API, which validates it as JSON Schema: a bare property map is
 * not an object schema, and an author-only `required: true` is not a valid
 * `required` keyword. Either mistake makes every request fail with HTTP 400
 * before the model sees a single turn.
 */
function parameterSchema(properties) {
  return toStandardJsonSchema({ type: 'object', properties })
}

/**
 * Reject a malformed model-facing schema while the plugin loads, instead of
 * letting the provider reject every request. Only structural problems that
 * break tool calling are checked; annotations and unknown keywords are left
 * for the API.
 */
function assertToolSchema(tool) {
  const fail = (path, message) => {
    throw new Error(`dsh-xcode: ${tool.name}.parameters${path} ${message}`)
  }
  const visit = (node, path, depth) => {
    if (depth > 32) fail(path, 'nests deeper than the supported 32 levels.')
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      fail(path, 'must be a JSON Schema object.')
    }
    if (node.type !== undefined && !SCHEMA_TYPES.has(node.type)) {
      fail(path, `has unsupported type ${JSON.stringify(node.type)}.`)
    }
    if (node.required !== undefined
      && (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string'))) {
      fail(`${path}.required`, 'must be an array of property names, not an author-DSL boolean.')
    }
    if (node.type === 'object'
      && (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties))) {
      fail(path, 'must declare an object properties map.')
    }
    if (node.properties !== undefined) {
      if (typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        fail(`${path}.properties`, 'must map property names to schemas.')
      }
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, `${path}.properties.${key}`, depth + 1)
      }
    }
    if (node.items !== undefined) {
      if (node.type !== 'array') fail(`${path}.items`, 'is only valid on an array schema.')
      visit(node.items, `${path}.items`, depth + 1)
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
      fail(`${path}.enum`, 'must be a non-empty array.')
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties`, 'must be a boolean.')
    }
    if (node.oneOf !== undefined) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        fail(`${path}.oneOf`, 'must contain at least two schemas.')
      }
      node.oneOf.forEach((child, index) => visit(child, `${path}.oneOf[${index}]`, depth + 1))
    }
  }
  if (!tool.parameters || tool.parameters.type !== 'object') {
    fail('', 'must be an object-rooted JSON Schema ({ type: "object", properties }).')
  }
  visit(tool.parameters, '', 0)
}

function textOutput(schema) {
  return {
    schema,
    render: (_args, value) => [
      { type: 'text', text: clip(value?.summary ?? JSON.stringify(value), MAX_TEXT) },
    ],
  }
}

/**
 * Tool results cross the session log as lossless JSON. Optional fields are
 * omitted instead of carried as `undefined`, non-finite numbers become null,
 * and bigints become strings. Normalizing once at the registration boundary
 * keeps every execute path safe without repeating the cleanup in each action.
 */
function toLosslessJson(value) {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString()
    if (typeof item === 'number' && !Number.isFinite(item)) return null
    if (typeof item === 'function' || typeof item === 'symbol') return undefined
    return item
  })
  return encoded === undefined ? null : JSON.parse(encoded)
}

function makeContextTool(ctx, mcp) {
  return {
    name: 'xcode_context',
    description:
      'Inspect and configure the Xcode workspace that is open in Xcode, through Apple’s official Xcode MCP server. Actions: status (Xcode/MCP/permission health), list (open workspaces), open (open a .xcodeproj/.xcworkspace), inspect (schemes, targets, run destinations, test plans), select (switch scheme/destination/test plan). Call this before build/test/run when the active Xcode target is unclear. Xcode must be running; the first open asks for Xcode’s one-time agent approval.',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'list', 'open', 'inspect', 'select'],
        description: 'status | list | open | inspect | select',
      },
      path: {
        type: 'string',
        description: 'Absolute path to an .xcodeproj or .xcworkspace. Required for open.',
      },
      workspace: {
        type: 'string',
        description:
          'Workspace identifier or absolute project path. Omit when exactly one workspace is open.',
      },
      scheme: {
        type: 'string',
        description: 'Scheme to make active for select.',
      },
      destination: {
        type: 'string',
        description:
          'Run destination display title to make active for select, e.g. "My Mac" or "iPhone 17".',
      },
      testPlan: {
        type: 'string',
        description: 'Test plan name to make active for select.',
      },
    }),
    output: textOutput(
      outputSchema({
        action: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        workspace: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            path: { type: 'string' },
          },
        },
        workspaces: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              path: { type: 'string' },
            },
          },
        },
        schemes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              active: { type: 'boolean', required: true },
              shared: { type: 'boolean' },
              container: { type: 'string' },
            },
          },
        },
        targets: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              project: { type: 'string' },
              productType: { type: 'string' },
              isTest: { type: 'boolean' },
            },
          },
        },
        destinations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              group: { type: 'string' },
              platform: { type: 'string' },
              osVersion: { type: 'string' },
              eligible: { type: 'boolean' },
              active: { type: 'boolean' },
            },
          },
        },
        testPlans: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              active: { type: 'boolean' },
            },
          },
        },
        activeScheme: { type: 'string' },
        activeDestination: { type: 'string' },
        activeTestPlan: { type: 'string' },
        xcodeVersion: { type: 'string' },
        mcpStatus: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      }),
    ),
    timeoutMs: 360_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: `Xcode: ${args.action}`,
        kind: 'execute',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      if (action === 'status') {
        const [versionResult, mcpStatusResult, workspacesResult] = await Promise.allSettled([
          runCommand(ctx, [XCRUN, 'xcodebuild', '-version'], exec, { timeoutMs: 20_000 }),
          runCommand(ctx, [XCRUN, 'mcp-server', 'status', '--format', 'json'], exec, {
            timeoutMs: 20_000,
          }),
          mcp.callTool('XcodeListWorkspaces', {}, { timeoutMs: 45_000, signal: exec.signal }),
        ])
        const versionText =
          versionResult.status === 'fulfilled'
            ? versionResult.value.stdout.trim().split('\n').slice(0, 2).join(' · ')
            : 'unavailable'
        let mcpStatus = 'unavailable'
        let permission = 'unknown'
        if (mcpStatusResult.status === 'fulfilled') {
          try {
            const status = JSON.parse(mcpStatusResult.value.stdout)
            mcpStatus = status.running ? 'running' : 'not running'
            const enabled = status.permission?.enabled ? 'enabled' : 'disabled'
            const agents = status.permission?.permittedAgents?.length ?? 0
            const folders = status.permission?.permittedFolders?.length ?? 0
            permission = `${enabled}; ${agents} approved agent(s), ${folders} approved folder(s)`
          } catch {
            mcpStatus = 'unreadable'
          }
        }
        const workspaces =
          workspacesResult.status === 'fulfilled' ? parseWorkspaces(workspacesResult.value) : []
        const notes = []
        if (workspacesResult.status === 'rejected') {
          notes.push(
            `Open workspaces could not be read: ${workspacesResult.reason?.message ?? workspacesResult.reason}`,
          )
        }
        const lines = [
          `Xcode: ${versionText}`,
          `Xcode MCP bridge: ${mcp.statusLine()}`,
          `MCP server: ${mcpStatus}`,
          `Permission: ${permission}`,
          workspaces.length
            ? `Open workspaces (${workspaces.length}):`
            : 'Open workspaces: none (or not readable yet)',
          ...workspaces.map((workspace) => `- ${formatWorkspace(workspace)}`),
          ...notes.map((note) => `Note: ${note}`),
        ]
        return {
          action,
          summary: lines.join('\n'),
          workspaces,
          xcodeVersion: versionText,
          mcpStatus,
          notes,
        }
      }

      if (action === 'list') {
        const value = await mcp.callTool('XcodeListWorkspaces', {}, { timeoutMs: 60_000, signal: exec.signal })
        const workspaces = parseWorkspaces(value)
        return {
          action,
          summary: workspaces.length
            ? `Open workspaces (${workspaces.length}):\n${workspaces.map((workspace) => `- ${formatWorkspace(workspace)}`).join('\n')}`
            : 'No Xcode workspace is open. Use action="open" with an absolute project path.',
          workspaces,
        }
      }

      if (action === 'open') {
        if (!args.path) throw new Error('xcode_context open requires path=<absolute .xcodeproj or .xcworkspace>.')
        const workspace = await resolveWorkspace(mcp, { workspace: args.path }, exec.signal)
        const activeScheme = workspace.opened?.activeScheme
        const activeDestination = workspace.opened?.activeRunDestination
        return {
          action,
          summary: [
            `Opened ${workspace.path ?? workspace.id}`,
            `Workspace: ${workspace.id}`,
            activeScheme ? `Scheme: ${activeScheme}` : null,
            activeDestination ? `Destination: ${activeDestination}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          workspace: { id: workspace.id, path: workspace.path ?? undefined },
          activeScheme,
          activeDestination,
        }
      }

      if (action === 'inspect') {
        const workspace = await resolveWorkspace(mcp, args, exec.signal)
        const notes = []
        const schemesValue = await mcp.callTool(
          'XcodeListSchemes',
          { workspaceIdentifier: workspace.id },
          { timeoutMs: 60_000, signal: exec.signal },
        )
        const targetsValue = await mcp
          .callTool(
            'XcodeListTargets',
            { workspaceIdentifier: workspace.id },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          .catch((error) => {
            notes.push(`Targets unavailable: ${error.message}`)
            return { targets: [] }
          })
        const destinationsValue = await mcp
          .callTool(
            'XcodeListRunDestinations',
            { workspaceIdentifier: workspace.id },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          .catch((error) => {
            notes.push(`Run destinations unavailable: ${error.message}`)
            return { destinations: [] }
          })
        const testPlansValue = await mcp
          .callTool(
            'XcodeListTestPlans',
            { workspaceIdentifier: workspace.id },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          .catch((error) => {
            notes.push(`Test plans unavailable: ${error.message}`)
            return { testPlans: [], usesTestPlans: false }
          })

        const schemes = (schemesValue.schemes ?? []).map((scheme) => ({
          name: scheme.name,
          active: Boolean(scheme.isActive),
          shared: Boolean(scheme.isShared),
          container: scheme.containerName,
        }))
        const targets = (targetsValue.targets ?? []).map((target) => ({
          name: target.name,
          project: target.containingProjectPath,
          productType: target.productTypeIdentifier,
          isTest: Boolean(target.isTestTarget),
        }))
        const destinations = (destinationsValue.destinations ?? []).map((destination) => ({
          name: destination.displayTitle,
          group: destination.group,
          platform: destination.platformIdentifier,
          osVersion: destination.osVersion,
          eligible: destination.isEligible,
          active: destination.isActive,
        }))
        const testPlans = (testPlansValue.testPlans ?? []).map((plan) => ({
          name: plan.name,
          active: Boolean(plan.isActive),
        }))
        const activeScheme = schemesValue.activeSchemeName ?? destinationsValue.activeSchemeName
        const activeDestination = destinationsValue.activeDestinationDisplayTitle
        const activeTestPlan = testPlansValue.activeTestPlanName
        const lines = [
          `Workspace: ${workspaceHeader(workspace)}`,
          activeScheme ? `Active scheme: ${activeScheme}` : 'Active scheme: none',
          activeDestination ? `Active destination: ${activeDestination}` : 'Active destination: none',
          activeTestPlan ? `Active test plan: ${activeTestPlan}` : null,
          '',
          `Schemes (${schemes.length}): ${schemes
            .slice(0, 12)
            .map((scheme) => `${scheme.name}${scheme.active ? '*' : ''}`)
            .join(', ') || 'none'}`,
          `Targets (${targets.length}): ${targets
            .slice(0, 16)
            .map((target) => `${target.name}${target.isTest ? ' [test]' : ''}`)
            .join(', ') || 'none'}`,
          `Destinations (${destinations.length}): ${destinations
            .slice(0, 12)
            .map(
              (destination) =>
                `${destination.name}${destination.active ? '*' : ''}${destination.eligible === false ? ' (ineligible)' : ''}`,
            )
            .join(', ') || 'none'}`,
          `Test plans (${testPlans.length}): ${testPlans
            .slice(0, 8)
            .map((plan) => `${plan.name}${plan.active ? '*' : ''}`)
            .join(', ') || 'none'}`,
          ...notes.map((note) => `Note: ${note}`),
        ]
        return {
          action,
          summary: lines.filter((line) => line !== null).join('\n'),
          workspace: { id: workspace.id, path: workspace.path ?? undefined },
          schemes,
          targets,
          destinations,
          testPlans,
          activeScheme,
          activeDestination,
          activeTestPlan,
          notes,
        }
      }

      if (action === 'select') {
        if (!args.scheme && !args.destination && !args.testPlan) {
          throw new Error('xcode_context select requires at least one of scheme, destination, or testPlan.')
        }
        const workspace = await resolveWorkspace(mcp, args, exec.signal)
        const changes = []
        if (args.scheme) {
          const switched = await mcp.callTool(
            'XcodeSwitchScheme',
            { workspaceIdentifier: workspace.id, schemeName: args.scheme },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          changes.push(`scheme=${switched.activeSchemeName ?? args.scheme}`)
        }
        if (args.destination) {
          const switched = await mcp.callTool(
            'XcodeSwitchRunDestination',
            { workspaceIdentifier: workspace.id, displayTitle: args.destination },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          changes.push(`destination=${switched.activeDestinationDisplayTitle ?? args.destination}`)
        }
        if (args.testPlan) {
          const switched = await mcp.callTool(
            'XcodeSwitchTestPlan',
            { workspaceIdentifier: workspace.id, testPlanName: args.testPlan },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          changes.push(`testPlan=${switched.activeTestPlanName ?? args.testPlan}`)
        }
        const current = await mcp
          .callTool(
            'XcodeListRunDestinations',
            { workspaceIdentifier: workspace.id },
            { timeoutMs: 60_000, signal: exec.signal },
          )
          .catch(() => ({}))
        return {
          action,
          summary: `Selected ${changes.join(', ')} in ${workspaceHeader(workspace)}.`,
          workspace: { id: workspace.id, path: workspace.path ?? undefined },
          activeScheme: current.activeSchemeName,
          activeDestination: current.activeDestinationDisplayTitle,
        }
      }

      throw new Error(`Unknown xcode_context action: ${action}`)
    },
  }
}

function makeBuildTool(mcp) {
  return {
    name: 'xcode_build',
    description:
      'Build the active scheme of an Xcode workspace with Xcode’s build system and return structured diagnostics plus a full log path. Xcode’s active run destination is used, so inspect/select it first when needed. Build failures are normal results (`success:false`) with errors, not tool failures. Use `buildForTesting` to also build test targets.',
    parameters: parameterSchema({
      workspace: {
        type: 'string',
        description:
          'Workspace identifier or absolute project path. Omit when exactly one workspace is open.',
      },
      buildForTesting: {
        type: 'boolean',
        description: 'Also build test targets that a normal build would skip. Default: false.',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'remark'],
        description:
          'Minimum diagnostic severity to return from the build log. Default: warning (errors + warnings).',
      },
      pattern: {
        type: 'string',
      },
      glob: {
        type: 'string',
        description: 'Optional file glob used to filter build-log issues.',
      },
    }),
    output: textOutput(
      outputSchema({
        summary: { type: 'string', required: true },
        success: { type: 'boolean', required: true },
        buildResult: { type: 'string', required: true },
        elapsedTime: { type: 'number' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              message: { type: 'string', required: true },
              filePath: { type: 'string' },
              lineNumber: { type: 'integer' },
              severity: { type: 'string' },
            },
          },
        },
        warnings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              message: { type: 'string', required: true },
              filePath: { type: 'string' },
              lineNumber: { type: 'integer' },
              severity: { type: 'string' },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              message: { type: 'string', required: true },
              filePath: { type: 'string' },
              lineNumber: { type: 'integer' },
              severity: { type: 'string' },
              task: { type: 'string' },
            },
          },
        },
        logPath: { type: 'string' },
        workspace: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      }),
    ),
    timeoutMs: BUILD_TIMEOUT_MS + 180_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: args.workspace ? `Build ${args.workspace}` : 'Build Xcode project',
        kind: 'execute',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const workspace = await resolveWorkspace(mcp, args, exec.signal)
      const build = await mcp.callTool(
        'BuildProject',
        {
          workspaceIdentifier: workspace.id,
          buildForTesting: args.buildForTesting === true,
        },
        { timeoutMs: BUILD_TIMEOUT_MS, signal: exec.signal },
      )
      const buildResult = String(build.buildResult ?? 'Xcode returned no build result.')
      const notes = []
      let log = {}
      try {
        log = await mcp.callTool(
          'GetBuildLog',
          {
            workspaceIdentifier: workspace.id,
            severity: args.severity || 'warning',
            ...(args.pattern ? { pattern: args.pattern } : {}),
            ...(args.glob ? { glob: args.glob } : {}),
          },
          { timeoutMs: 120_000, signal: exec.signal },
        )
      } catch (error) {
        notes.push(`Build log unavailable: ${error.message}`)
      }

      const issues = []
      for (const error of Array.isArray(build.errors) ? build.errors : []) {
        issues.push({
          message: String(error.message ?? ''),
          filePath: error.filePath ? String(error.filePath) : undefined,
          lineNumber: Number.isInteger(error.lineNumber) ? error.lineNumber : undefined,
          severity: String(error.classification ?? 'error'),
        })
      }
      for (const entry of Array.isArray(log.buildLogEntries) ? log.buildLogEntries : []) {
        for (const emitted of Array.isArray(entry.emittedIssues) ? entry.emittedIssues : []) {
          issues.push({
            message: String(emitted.message ?? ''),
            filePath: emitted.path ? String(emitted.path) : undefined,
            lineNumber: Number.isInteger(emitted.line) ? emitted.line : undefined,
            severity: String(emitted.severity ?? 'error'),
            task: entry.buildTask ? clip(entry.buildTask, 300) : undefined,
          })
        }
      }
      const deduped = dedupeIssues(issues.filter((issue) => issue.message))
      const errors = deduped.filter((issue) => /error/i.test(issue.severity)).slice(0, MAX_ISSUES)
      const warnings = deduped
        .filter((issue) => /warning/i.test(issue.severity))
        .slice(0, MAX_ISSUES)
      const success = errors.length === 0 && /succeed|success|built successfully|build complete/i.test(buildResult)
      const logPath = log.fullLogPath || build.fullLogPath
      const elapsedTime =
        typeof build.elapsedTime === 'number' ? Math.round(build.elapsedTime * 10) / 10 : undefined
      const lines = [
        `${success ? 'BUILD SUCCEEDED' : 'BUILD FAILED'}${elapsedTime != null ? ` in ${elapsedTime}s` : ''}`,
        `Workspace: ${workspaceHeader(workspace)}`,
        `Result: ${buildResult}`,
        `Errors: ${errors.length}${errors.length >= MAX_ISSUES ? '+' : ''} · Warnings: ${warnings.length}${warnings.length >= MAX_ISSUES ? '+' : ''}`,
      ]
      if (errors.length) {
        lines.push('Errors:')
        for (const issue of errors.slice(0, 20)) lines.push(`- ${formatIssue(issue)}`)
      }
      if (warnings.length) {
        lines.push('Warnings:')
        for (const issue of warnings.slice(0, 12)) lines.push(`- ${formatIssue(issue)}`)
      }
      if (logPath) lines.push(`Full log: ${logPath}`)
      if (deduped.length > errors.length + warnings.length) {
        lines.push(`Note: ${deduped.length - errors.length - warnings.length} lower-severity diagnostic(s) omitted.`)
      }
      for (const note of notes) lines.push(`Note: ${note}`)
      return {
        summary: lines.join('\n'),
        success,
        buildResult,
        elapsedTime,
        errors,
        warnings,
        issues: deduped.slice(0, MAX_ISSUES),
        logPath,
        workspace: workspaceHeader(workspace),
        notes,
      }
    },
  }
}

function makeTestTool(mcp) {
  return {
    name: 'xcode_test',
    description:
      'List or run tests for the active scheme and test plan using Xcode. Actions: list (discover test identifiers), all (run every enabled test), some (run exact targetName/testIdentifier pairs). Returns counts, failures, and full result/log paths. Use xcode_context to select the scheme, destination, and test plan first.',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'all', 'some'],
        description: 'list | all | some',
      },
      workspace: {
        type: 'string',
        description:
          'Workspace identifier or absolute project path. Omit when exactly one workspace is open.',
      },
      tests: {
        type: 'array',
        description: 'For action=some: exact test specifiers to run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetName: { type: 'string', required: true },
            testIdentifier: { type: 'string', required: true },
          },
        },
      },
    }),
    output: textOutput(
      outputSchema({
        summary: { type: 'string', required: true },
        action: { type: 'string', required: true },
        success: { type: 'boolean' },
        schemeName: { type: 'string' },
        activeTestPlanName: { type: 'string' },
        counts: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer' },
            passed: { type: 'integer' },
            failed: { type: 'integer' },
            skipped: { type: 'integer' },
            expectedFailures: { type: 'integer' },
            notRun: { type: 'integer' },
            enabled: { type: 'integer' },
            disabled: { type: 'integer' },
          },
        },
        tests: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              targetName: { type: 'string', required: true },
              identifier: { type: 'string', required: true },
              displayName: { type: 'string' },
              enabled: { type: 'boolean' },
              filePath: { type: 'string' },
              lineNumber: { type: 'integer' },
            },
          },
        },
        results: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              targetName: { type: 'string' },
              identifier: { type: 'string' },
              displayName: { type: 'string' },
              state: { type: 'string' },
              errorMessages: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        fullSummaryPath: { type: 'string' },
        fullConsoleLogsPath: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      }),
    ),
    timeoutMs: TEST_TIMEOUT_MS + 180_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: args.action === 'list' ? 'List Xcode tests' : `Run Xcode tests (${args.action})`,
        kind: 'execute',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      const workspace = await resolveWorkspace(mcp, args, exec.signal)
      if (action === 'list') {
        const value = await mcp.callTool(
          'GetTestList',
          { workspaceIdentifier: workspace.id },
          { timeoutMs: 120_000, signal: exec.signal },
        )
        const tests = (value.tests ?? []).map((test) => ({
          targetName: test.targetName,
          identifier: test.identifier,
          displayName: test.displayName,
          enabled: test.isEnabled,
          filePath: test.filePath,
          lineNumber: test.lineNumber,
        }))
        const counts = {
          total: value.counts?.total ?? tests.length,
          enabled: value.counts?.enabled ?? tests.filter((test) => test.enabled).length,
          disabled: value.counts?.disabled ?? tests.filter((test) => !test.enabled).length,
        }
        const lines = [
          `Tests in ${value.schemeName ?? 'active scheme'} (${value.activeTestPlanName ?? 'legacy test targets'})`,
          `Total: ${counts.total} · enabled: ${counts.enabled} · disabled: ${counts.disabled}`,
          ...tests.slice(0, 40).map(
            (test) => `- ${test.targetName} / ${test.identifier} — ${test.displayName}${test.enabled ? '' : ' (disabled)'}`,
          ),
        ]
        if (value.truncated || tests.length > 40) lines.push(`… full list: ${value.fullTestListPath}`)
        return {
          summary: lines.join('\n'),
          action,
          success: true,
          schemeName: value.schemeName,
          activeTestPlanName: value.activeTestPlanName,
          counts,
          tests,
        }
      }

      if (action === 'all') {
        const value = await mcp.callTool(
          'RunAllTests',
          { workspaceIdentifier: workspace.id },
          { timeoutMs: TEST_TIMEOUT_MS, signal: exec.signal },
        )
        return testRunResult(value, action, workspace)
      }

      if (action === 'some') {
        if (!Array.isArray(args.tests) || args.tests.length === 0) {
          throw new Error('xcode_test action="some" requires a non-empty tests array.')
        }
        const tests = args.tests.map((test) => {
          if (!test?.targetName || !test?.testIdentifier) {
            throw new Error('Each tests entry requires targetName and testIdentifier.')
          }
          return { targetName: String(test.targetName), testIdentifier: String(test.testIdentifier) }
        })
        const value = await mcp.callTool(
          'RunSomeTests',
          { workspaceIdentifier: workspace.id, tests },
          { timeoutMs: TEST_TIMEOUT_MS, signal: exec.signal },
        )
        return testRunResult(value, action, workspace)
      }

      throw new Error(`Unknown xcode_test action: ${action}`)
    },
  }
}

function testRunResult(value, action, workspace) {
  const counts = {
    total: value.counts?.total ?? 0,
    passed: value.counts?.passed ?? 0,
    failed: value.counts?.failed ?? 0,
    skipped: value.counts?.skipped ?? 0,
    expectedFailures: value.counts?.expectedFailures ?? 0,
    notRun: value.counts?.notRun ?? 0,
  }
  const results = (value.results ?? []).map((result) => ({
    targetName: result.targetName,
    identifier: result.identifier,
    displayName: result.displayName,
    state: result.state,
    errorMessages: result.errorMessages ?? [],
  }))
  const failures = results.filter(
    (result) =>
      /fail|error/i.test(String(result.state ?? '')) ||
      (Array.isArray(result.errorMessages) && result.errorMessages.length > 0),
  )
  const success = counts.failed === 0
  const lines = [
    `${success ? 'TESTS PASSED' : 'TESTS FAILED'} — ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped (${counts.total} total)`,
    `Scheme: ${value.schemeName ?? workspace.id}${value.activeTestPlanName ? ` · Test plan: ${value.activeTestPlanName}` : ''}`,
  ]
  if (failures.length) {
    lines.push('Failures:')
    for (const failure of failures.slice(0, 20)) {
      lines.push(`- ${failure.targetName} / ${failure.identifier} [${failure.state}]`)
      for (const message of (failure.errorMessages ?? []).slice(0, 3)) {
        lines.push(`  ${clip(message, 600)}`)
      }
    }
  }
  if (value.message) lines.push(`Note: ${value.message}`)
  if (value.fullSummaryPath) lines.push(`Full results: ${value.fullSummaryPath}`)
  if (value.fullConsoleLogsPath) lines.push(`Console logs: ${value.fullConsoleLogsPath}`)
  return {
    summary: lines.join('\n'),
    action,
    success,
    schemeName: value.schemeName,
    activeTestPlanName: value.activeTestPlanName,
    counts,
    results,
    fullSummaryPath: value.fullSummaryPath,
    fullConsoleLogsPath: value.fullConsoleLogsPath,
  }
}

function makeRunTool(mcp) {
  return {
    name: 'xcode_run',
    description:
      'Run, stop, debug, or inspect the app in the active Xcode workspace. Actions: run (build and launch, optional debugger), stop, console (read stdout/stderr/OSLog from the current or last launch), preview (render a SwiftUI #Preview to a PNG and return its path), debug (execute an LLDB command in the active debug session). Use xcode_context to select scheme and destination first.',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['run', 'stop', 'console', 'preview', 'debug'],
        description: 'run | stop | console | preview | debug',
      },
      workspace: {
        type: 'string',
        description:
          'Workspace identifier or absolute project path. Omit when exactly one workspace is open.',
      },
      attachDebugger: {
        type: 'boolean',
        description: 'For run: attach Xcode’s debugger after launch. Default: false.',
      },
      outputType: {
        type: 'string',
        enum: ['all', 'stdio', 'oslog'],
        description: 'For console: which output stream to read. Default: all.',
      },
      pattern: {
        type: 'string',
        description: 'For console: optional regular expression filter.',
      },
      tailLimit: {
        type: 'integer',
        description: 'For console: return at most this many trailing lines (default 200, max 2000).',
      },
      contextLines: {
        type: 'integer',
        description: 'For console: lines of context around pattern matches.',
      },
      includeMetadata: {
        type: 'boolean',
        description: 'For console: include OSLog subsystem/category/process metadata.',
      },
      launchSessionReference: {
        type: 'string',
        description: 'For console: a specific launch session reference; omit for the latest.',
      },
      sourceFile: {
        type: 'string',
        description:
          'For preview: the Swift file containing the #Preview, absolute or Xcode project-relative (e.g. "XcodeAgentDemo/ContentView.swift").',
      },
      previewIndex: {
        type: 'integer',
        description: 'For preview: zero-based index of the preview definition in the file. Default: 0.',
      },
      previewLocalization: {
        type: 'string',
        description: 'For preview: locale identifier, e.g. "en" or "ja".',
      },
      command: {
        type: 'string',
        description: 'For debug: LLDB command, e.g. "bt", "po self", "thread step-over".',
      },
      commandTimeout: {
        type: 'integer',
        description: 'For debug: seconds Xcode waits for the LLDB command. Default: 30.',
      },
    }),
    output: textOutput(
      outputSchema({
        summary: { type: 'string', required: true },
        action: { type: 'string', required: true },
        success: { type: 'boolean' },
        runResult: { type: 'string' },
        processIdentifier: { type: 'integer' },
        launchSessionReference: { type: 'string' },
        buildErrors: { type: 'array', items: { type: 'object' } },
        logPath: { type: 'string' },
        output: { type: 'string' },
        launchSessionInfo: { type: 'string' },
        consoleTruncated: { type: 'boolean' },
        previewPath: { type: 'string' },
        displayName: { type: 'string' },
        previewErrors: { type: 'array', items: { type: 'string' } },
        debugSessionActive: { type: 'boolean' },
        debugWaiting: { type: 'boolean' },
      }),
    ),
    timeoutMs: 900_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: `Xcode: ${args.action}`,
        kind: 'execute',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      const workspace = await resolveWorkspace(mcp, args, exec.signal)
      if (action === 'run') {
        const value = await mcp.callTool(
          'RunProject',
          { workspaceIdentifier: workspace.id, attachDebugger: args.attachDebugger === true },
          { timeoutMs: RUN_TIMEOUT_MS, signal: exec.signal },
        )
        const buildErrors = Array.isArray(value.buildErrors) ? value.buildErrors : []
        const success = buildErrors.length === 0 && /success|launch/i.test(String(value.runResult ?? ''))
        const lines = [
          `${success ? 'APP LAUNCHED' : 'APP DID NOT LAUNCH'}${value.processIdentifier ? ` · PID ${value.processIdentifier}` : ''}`,
          `Result: ${value.runResult ?? 'unknown'}`,
          `Session: ${value.launchSessionReference ?? 'unknown'}`,
        ]
        if (buildErrors.length) {
          lines.push('Build errors:')
          for (const error of buildErrors.slice(0, 12)) lines.push(`- ${formatIssue(error)}`)
        }
        if (value.fullLogPath) lines.push(`Build log: ${value.fullLogPath}`)
        return {
          summary: lines.join('\n'),
          action,
          success,
          runResult: value.runResult,
          processIdentifier: value.processIdentifier,
          launchSessionReference: value.launchSessionReference,
          buildErrors,
          logPath: value.fullLogPath,
        }
      }

      if (action === 'stop') {
        const value = await mcp.callTool(
          'StopProject',
          { workspaceIdentifier: workspace.id },
          { timeoutMs: 60_000, signal: exec.signal },
        )
        return {
          summary: `${value.stopResult ?? 'Stopped.'}${value.processIdentifier ? ` (PID ${value.processIdentifier})` : ''}`,
          action,
          success: true,
          processIdentifier: value.processIdentifier,
        }
      }

      if (action === 'console') {
        const tailLimit = Math.min(Math.max(Number(args.tailLimit) || 200, 1), 2_000)
        const value = await mcp.callTool(
          'GetConsoleOutput',
          {
            workspaceIdentifier: workspace.id,
            outputType: args.outputType || 'all',
            tailLimit,
            ...(args.pattern ? { pattern: args.pattern } : {}),
            ...(Number.isFinite(Number(args.contextLines)) ? { contextLines: Number(args.contextLines) } : {}),
            ...(args.includeMetadata === true ? { includeMetadata: true } : {}),
            ...(args.launchSessionReference ? { launchSessionReference: args.launchSessionReference } : {}),
          },
          { timeoutMs: 120_000, signal: exec.signal },
        )
        const units = Array.isArray(value.units) ? value.units : []
        const lines = []
        for (const unit of units) {
          const prefix = unit.kind === 'oslog' ? `[oslog${unit.severity ? `:${unit.severity}` : ''}] ` : ''
          const content = String(unit.content ?? '')
          lines.push(`${prefix}${content}`)
        }
        const outputText = lines.join('\n')
        const summaryLines = [
          `Console: ${value.launchSessionInfo ?? 'launch session'}`,
          `Lines: ${value.totalCount ?? units.length}${value.truncated ? ` (truncated to last ${tailLimit})` : ''}`,
          outputText || '(no console output yet)',
        ]
        return {
          summary: clip(summaryLines.join('\n'), MAX_TEXT),
          action,
          success: true,
          output: clip(outputText, MAX_TEXT),
          launchSessionInfo: value.launchSessionInfo,
          consoleTruncated: Boolean(value.truncated),
        }
      }

      if (action === 'preview') {
        if (!args.sourceFile) {
          throw new Error(
            'xcode_run action="preview" requires sourceFile=<Swift file path, absolute or project-relative>.',
          )
        }
        const sourceFilePath = projectRelativePath(String(args.sourceFile), workspace)
        if (isAbsolute(sourceFilePath)) {
          throw new Error(
            `sourceFile must be inside the project container (${workspace.path ? dirname(workspace.path) : 'unknown'}) or already project-relative, e.g. "XcodeAgentDemo/ContentView.swift".`,
          )
        }
        const value = await mcp.callTool(
          'RenderPreview',
          {
            workspaceIdentifier: workspace.id,
            sourceFilePath,
            previewDefinitionIndexInFile: Number.isInteger(args.previewIndex) ? args.previewIndex : 0,
            ...(args.previewLocalization ? { previewLocalizationOverride: String(args.previewLocalization) } : {}),
          },
          { timeoutMs: RUN_TIMEOUT_MS, signal: exec.signal },
        )
        const previewErrors = (value.errors ?? []).map((error) => String(error.message ?? ''))
        const success = Boolean(value.previewSnapshotPath) && previewErrors.length === 0
        const lines = [
          success ? `PREVIEW RENDERED: ${value.displayName ?? 'preview'}` : `PREVIEW FAILED: ${value.displayName ?? 'preview'}`,
          value.previewSnapshotPath ? `Snapshot: ${value.previewSnapshotPath}` : null,
          value.renderedDestination?.platformName
            ? `Destination: ${value.renderedDestination.platformName}${value.renderedDestination.deviceModelName ? ` · ${value.renderedDestination.deviceModelName}` : ''}`
            : null,
          ...previewErrors.map((message) => `Error: ${clip(message, 800)}`),
        ].filter(Boolean)
        return {
          summary: lines.join('\n'),
          action,
          success,
          previewPath: value.previewSnapshotPath,
          displayName: value.displayName,
          previewErrors,
        }
      }

      if (action === 'debug') {
        if (!args.command) throw new Error('xcode_run action="debug" requires command=<LLDB command>.')
        const value = await mcp.callTool(
          'InvokeDebuggerCommand',
          {
            workspaceIdentifier: workspace.id,
            command: String(args.command),
            ...(Number.isFinite(Number(args.commandTimeout))
              ? { timeout: Math.max(1, Math.trunc(Number(args.commandTimeout))) }
              : {}),
          },
          { timeoutMs: 180_000, signal: exec.signal },
        )
        return {
          summary: [
            `Debugger ${value.debugSessionActive ? 'active' : 'inactive'}${value.processIdentifier ? ` · PID ${value.processIdentifier}` : ''}`,
            value.isWaitingForMore && !String(value.output ?? '').trim()
              ? 'Command is still running/timeout; call again with a simple command to inspect state.'
              : null,
            String(value.output ?? '').trim() || '(no debugger output)',
          ]
            .filter(Boolean)
            .join('\n'),
          action,
          success: true,
          output: clip(String(value.output ?? ''), MAX_TEXT),
          debugSessionActive: Boolean(value.debugSessionActive),
          debugWaiting: Boolean(value.isWaitingForMore),
          processIdentifier: value.processIdentifier,
        }
      }

      throw new Error(`Unknown xcode_run action: ${action}`)
    },
  }
}

function makeSimulatorTool(ctx) {
  return {
    name: 'xcode_simulator',
    description:
      'Manage Apple Simulators with `simctl`: list available devices, boot/shutdown, install and launch an app, terminate it, take a screenshot, or open a URL. This is independent of Xcode’s UI; use xcode_context/xcode_run for the Xcode build-and-run flow. Device defaults to "booted" except for boot, which needs a device name or UDID.',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'boot', 'shutdown', 'install', 'launch', 'terminate', 'screenshot', 'openurl'],
        description: 'list | boot | shutdown | install | launch | terminate | screenshot | openurl',
      },
      device: {
        type: 'string',
        description:
          'Simulator UDID, device name, or "booted". Defaults to "booted" for actions that can use the running device.',
      },
      appPath: {
        type: 'string',
        description: 'For install: absolute path to the built .app bundle.',
      },
      bundleId: {
        type: 'string',
        description: 'For launch/terminate: the app bundle identifier.',
      },
      launchArgs: {
        type: 'array',
        items: { type: 'string' },
        description: 'For launch: extra command-line arguments passed to the app.',
      },
      url: {
        type: 'string',
        description: 'For openurl: the URL to open in the simulator.',
      },
      outputPath: {
        type: 'string',
        description:
          'For screenshot: absolute PNG path. Defaults to a file under the system temporary directory.',
      },
    }),
    output: textOutput(
      outputSchema({
        summary: { type: 'string', required: true },
        action: { type: 'string', required: true },
        success: { type: 'boolean' },
        devices: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              udid: { type: 'string', required: true },
              state: { type: 'string' },
              runtime: { type: 'string' },
            },
          },
        },
        device: { type: 'string' },
        path: { type: 'string' },
        pid: { type: 'integer' },
        output: { type: 'string' },
      }),
    ),
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: `Simulator: ${args.action}`,
        kind: 'execute',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      const device = typeof args.device === 'string' && args.device.trim() ? args.device.trim() : 'booted'

      if (action === 'list') {
        const { stdout } = await simctl(ctx, exec, ['list', 'devices', 'available', '--json'])
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          throw new Error(`Could not parse simctl output: ${clip(stdout, 2_000)}`)
        }
        const devices = simulatorDevices(parsed)
        return {
          summary: simulatorSummary(devices),
          action,
          success: true,
          devices,
        }
      }

      if (action === 'boot') {
        if (!args.device) throw new Error('xcode_simulator action="boot" requires device=<name or UDID>.')
        let output = ''
        try {
          output = (await simctl(ctx, exec, ['boot', device], { timeoutMs: 120_000 })).stdout
        } catch (error) {
          if (!/current state:\s*Booted/i.test(String(error.message))) throw error
        }
        try {
          await simctl(ctx, exec, ['bootstatus', device, '-b'], { timeoutMs: 180_000 })
        } catch {
          // Boot was requested; bootstatus can be slow or unavailable on older runtimes.
        }
        let opened = true
        try {
          await runCommand(ctx, ['/usr/bin/open', '-a', 'Simulator'], exec, { timeoutMs: 20_000 })
        } catch {
          opened = false
        }
        return {
          summary: `Boot requested for ${device}${opened ? '; Simulator opened.' : '; Simulator.app could not be opened.'}`,
          action,
          success: true,
          device,
          output: clip(output.trim(), 2_000),
        }
      }

      if (action === 'shutdown') {
        const output = await simctl(ctx, exec, ['shutdown', device], { timeoutMs: 60_000 })
        return {
          summary: `Shutdown ${device}.`,
          action,
          success: true,
          device,
          output: clip(output.stdout.trim(), 2_000),
        }
      }

      if (action === 'install') {
        if (!args.appPath) throw new Error('xcode_simulator action="install" requires appPath=<absolute .app path>.')
        if (!isAbsolute(args.appPath)) throw new Error('appPath must be an absolute path.')
        try {
          const info = await stat(args.appPath)
          if (!info.isDirectory()) throw new Error('not a directory')
        } catch {
          throw new Error(`App bundle not found: ${args.appPath}`)
        }
        const output = await simctl(ctx, exec, ['install', device, args.appPath], { timeoutMs: 120_000 })
        return {
          summary: `Installed ${args.appPath} on ${device}.`,
          action,
          success: true,
          device,
          path: args.appPath,
          output: clip(output.stdout.trim(), 2_000),
        }
      }

      if (action === 'launch') {
        if (!args.bundleId) throw new Error('xcode_simulator action="launch" requires bundleId.')
        const launchArgs = Array.isArray(args.launchArgs)
          ? args.launchArgs.map((value) => String(value))
          : []
        const output = await simctl(ctx, exec, ['launch', device, args.bundleId, ...launchArgs], {
          timeoutMs: 120_000,
        })
        const pidMatch = output.stdout.match(/:\s*(\d+)\s*$/)
        const pid = pidMatch ? Number(pidMatch[1]) : undefined
        return {
          summary: `Launched ${args.bundleId} on ${device}${pid ? ` (PID ${pid})` : ''}.`,
          action,
          success: true,
          device,
          pid,
          output: clip(output.stdout.trim(), 2_000),
        }
      }

      if (action === 'terminate') {
        if (!args.bundleId) throw new Error('xcode_simulator action="terminate" requires bundleId.')
        const output = await simctl(ctx, exec, ['terminate', device, args.bundleId], { timeoutMs: 60_000 })
        return {
          summary: `Terminated ${args.bundleId} on ${device}.`,
          action,
          success: true,
          device,
          output: clip(output.stdout.trim(), 2_000),
        }
      }

      if (action === 'screenshot') {
        const outputPath = args.outputPath
          ? resolve(String(args.outputPath))
          : resolve(tmpdir(), 'dsh-xcode', `simulator-${Date.now()}.png`)
        if (!isAbsolute(outputPath)) throw new Error('outputPath must be absolute.')
        await mkdir(dirname(outputPath), { recursive: true })
        const output = await simctl(ctx, exec, ['io', device, 'screenshot', outputPath], {
          timeoutMs: 60_000,
        })
        return {
          summary: `Screenshot saved: ${outputPath}\n${clip(output.stdout.trim(), 500)}`.trim(),
          action,
          success: true,
          device,
          path: outputPath,
        }
      }

      if (action === 'openurl') {
        if (!args.url) throw new Error('xcode_simulator action="openurl" requires url.')
        const output = await simctl(ctx, exec, ['openurl', device, String(args.url)], { timeoutMs: 60_000 })
        return {
          summary: `Opened ${args.url} on ${device}.`,
          action,
          success: true,
          device,
          output: clip(output.stdout.trim(), 2_000),
        }
      }

      throw new Error(`Unknown xcode_simulator action: ${action}`)
    },
  }
}

export function apply(ctx) {
  const mcp = new XcodeMCP(ctx)
  const tools = [
    makeContextTool(ctx, mcp),
    makeBuildTool(mcp),
    makeTestTool(mcp),
    makeRunTool(mcp),
    makeSimulatorTool(ctx),
  ]
  for (const tool of tools) {
    const execute = tool.execute
    tool.execute = async (...args) => {
      const result =
        tool.name === 'xcode_simulator'
          ? await execute(...args)
          : await mcp.serialize(() => execute(...args))
      return toLosslessJson(result)
    }
    assertToolSchema(tool)
  }
  ctx.effect(() => () => mcp.close())
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }
}
