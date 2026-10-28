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

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
          clientInfo: { name: 'dsh-xcode', version: '0.3.0' },
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

  async callToolRaw(name, args = {}, { timeoutMs = 60_000, signal } = {}) {
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
    return { value: mcpValue(result), content: contentText(result) }
  }

  async callTool(name, args = {}, options = {}) {
    return (await this.callToolRaw(name, args, options)).value
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

/**
 * Like runCommand, but preserves stdout/stderr and the exit code for commands
 * whose failure is a normal result (xcodebuild diagnostics).
 */
async function runCommandCapture(ctx, argv, exec, { timeoutMs = 60_000, cwd = HOMEDIR, maxBytes = 8_000_000 } = {}) {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const onAbort = () => {
    cancelled = true
    controller.abort()
  }
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
        stderr: { maxBytes: 2_000_000, spill: { maxBytes: 4_000_000 } },
      },
      graceMs: 2_000,
      signal: controller.signal,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      },
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      outcome = { exitCode: null, signal: null, error }
    }
    const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
    if (timedOut) {
      throw new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.join(' ')}`)
    }
    if (cancelled) throw new Error('Command cancelled.')
    return {
      stdout,
      stderr,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    }
  } finally {
    clearTimeout(timer)
    if (exec.signal) exec.signal.removeEventListener('abort', onAbort)
  }
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

async function workspacePathFor(mcp, workspace, signal) {
  if (workspace.path) return workspace.path
  const listed = await mcp.callTool('XcodeListWorkspaces', {}, { timeoutMs: 60_000, signal })
  const found = parseWorkspaces(listed).find((entry) => entry.id === workspace.id)
  if (!found?.path) {
    throw new Error(`Cannot resolve the filesystem path for workspace ${workspace.id}. Pass workspace=<absolute path>.`)
  }
  return found.path
}

function parseXcodebuildIssues(text) {
  const issues = []
  const seen = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    let match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.*)$/i)
    if (!match) match = line.match(/^\s*(error|warning|note):\s*(.*)$/i)
    if (!match) continue
    const severity = match[4] ? match[4].toLowerCase() : match[1].toLowerCase()
    const message = match[5] ?? match[2]
    const filePath = match[4] ? match[1] : undefined
    const lineNumber = match[4] ? Number(match[2]) : undefined
    const key = `${severity}|${filePath ?? ''}|${lineNumber ?? ''}|${message}`
    if (seen.has(key)) continue
    seen.add(key)
    issues.push({
      severity: severity === 'note' ? 'remark' : severity,
      message,
      ...(filePath ? { filePath } : {}),
      ...(Number.isFinite(lineNumber) ? { lineNumber } : {}),
    })
    if (issues.length >= MAX_ISSUES * 4) break
  }
  return issues
}

async function runNativeBuild(ctx, mcp, workspace, args, exec) {
  const projectPath = await workspacePathFor(mcp, workspace, exec.signal)
  const schemes = await mcp.callTool(
    'XcodeListSchemes',
    { workspaceIdentifier: workspace.id },
    { timeoutMs: 60_000, signal: exec.signal },
  )
  const activeScheme =
    schemes.activeSchemeName ??
    (schemes.schemes ?? []).find((scheme) => scheme.isActive)?.name ??
    (schemes.schemes ?? [])[0]?.name
  if (!activeScheme) throw new Error('Xcode returned no active scheme for this workspace.')

  const configuration = String(args.configuration || 'Debug')
  const clean = args.clean === true
  const buildForTesting = args.buildForTesting === true
  const derivedDataPath = resolve(
    tmpdir(),
    'dsh-xcode-derived',
    createHash('sha1').update(projectPath).digest('hex').slice(0, 12),
    'DerivedData',
  )
  await mkdir(dirname(derivedDataPath), { recursive: true })
  const flag = /\.xcworkspace$/i.test(projectPath) ? '-workspace' : '-project'
  const argv = [
    XCRUN,
    'xcodebuild',
    flag,
    projectPath,
    '-scheme',
    activeScheme,
    '-configuration',
    configuration,
    '-derivedDataPath',
    derivedDataPath,
  ]
  if (args.destination) argv.push('-destination', String(args.destination))
  argv.push(...(clean ? ['clean'] : []), buildForTesting ? 'build-for-testing' : 'build')

  const started = Date.now()
  const result = await runCommandCapture(ctx, argv, exec, {
    timeoutMs: BUILD_TIMEOUT_MS,
    cwd: dirname(projectPath),
  })
  const elapsedTime = Math.round(((Date.now() - started) / 1000) * 10) / 10
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const issues = parseXcodebuildIssues(output)
  const errors = issues.filter((issue) => issue.severity === 'error').slice(0, MAX_ISSUES)
  const warnings = issues.filter((issue) => issue.severity === 'warning').slice(0, MAX_ISSUES)
  const success = result.exitCode === 0
  let logPath
  try {
    logPath = resolve(tmpdir(), `dsh-xcode-build-${Date.now()}.log`)
    await writeFile(logPath, `${output}\n`, 'utf8')
  } catch {
    logPath = undefined
  }
  const buildResult = `xcodebuild ${clean ? 'clean ' : ''}${buildForTesting ? 'build-for-testing' : 'build'} ${success ? 'succeeded' : `failed (exit ${result.exitCode ?? result.signal ?? 'unknown'})`}.`
  const lines = [
    `${success ? 'BUILD SUCCEEDED' : 'BUILD FAILED'}${Number.isFinite(elapsedTime) ? ` in ${elapsedTime}s` : ''}`,
    `Workspace: ${workspaceHeader(workspace)}`,
    `Configuration: ${configuration}${clean ? ' · clean' : ''}${args.destination ? ` · ${args.destination}` : ''}`,
    `Channel: xcodebuild`,
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
  lines.push(`DerivedData: ${derivedDataPath}`)
  const notes = ['Native xcodebuild path used because clean/configuration was requested.']
  return {
    summary: lines.join('\n'),
    success,
    buildResult,
    elapsedTime,
    configuration,
    clean,
    channel: 'xcodebuild',
    errors,
    warnings,
    issues: issues.slice(0, MAX_ISSUES),
    logPath,
    workspace: workspaceHeader(workspace),
    notes,
  }
}

function makeBuildTool(ctx, mcp) {
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
      configuration: {
        type: 'string',
        description:
          'Build configuration, for example Debug or Release. Supplying this uses the native xcodebuild path instead of Xcode’s active configuration.',
      },
      clean: {
        type: 'boolean',
        description:
          'Clean before building. Uses the native xcodebuild path; configuration defaults to Debug when omitted.',
      },
      destination: {
        type: 'string',
        description:
          'Optional xcodebuild -destination string, for example platform=macOS. Used only with configuration/clean.',
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
        configuration: { type: 'string' },
        clean: { type: 'boolean' },
        channel: { type: 'string' },
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
              task: { type: 'string' },
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
              task: { type: 'string' },
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
      if (args.clean === true || (typeof args.configuration === 'string' && args.configuration.trim())) {
        return runNativeBuild(ctx, mcp, workspace, args, exec)
      }
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
        // Match `list` semantics: a scheme without a test target is an empty
        // suite, not a failed test run. CI should not turn "0 tests" into red.
        const preflight = await mcp.callTool(
          'GetTestList',
          { workspaceIdentifier: workspace.id },
          { timeoutMs: 120_000, signal: exec.signal },
        )
        const preflightTotal = preflight.counts?.total ?? (preflight.tests?.length ?? 0)
        if (preflightTotal === 0) {
          return emptyTestResult(action, workspace, preflight)
        }
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
        try {
          const value = await mcp.callTool(
            'RunSomeTests',
            { workspaceIdentifier: workspace.id, tests },
            { timeoutMs: TEST_TIMEOUT_MS, signal: exec.signal },
          )
          return testRunResult(value, action, workspace)
        } catch (error) {
          if (/not testable|no tests? found|scheme .* not testable/i.test(String(error.message))) {
            return emptyTestResult(action, workspace, {}, 'The scheme has no test target; the selected tests did not run.')
          }
          throw error
        }
      }

      throw new Error(`Unknown xcode_test action: ${action}`)
    },
  }
}

function emptyTestResult(action, workspace, value, note = 'The active scheme has no tests to run.') {
  return {
    summary: [
      `TESTS PASSED — 0 tests (0 total)`,
      `Scheme: ${value?.schemeName ?? workspace.id}${value?.activeTestPlanName ? ` · Test plan: ${value.activeTestPlanName}` : ''}`,
      `Note: ${note}`,
    ].join('\n'),
    action,
    success: true,
    schemeName: value?.schemeName,
    activeTestPlanName: value?.activeTestPlanName,
    counts: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      expectedFailures: 0,
      notRun: 0,
    },
    results: [],
    notes: [note],
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
  const consoleCache = new Map()
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
      process: {
        type: 'string',
        description:
          'For console: only keep OSLog units whose processName contains this string. Forces metadata collection.',
      },
      subsystem: {
        type: 'string',
        description:
          'For console: only keep OSLog units whose subsystem contains this string. Forces metadata collection.',
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
        consoleCached: { type: 'boolean' },
        notes: { type: 'array', items: { type: 'string' } },
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
        // Keep a bounded console snapshot before stopping: Xcode can discard
        // the launch session immediately, which is exactly when crash logs are
        // most useful.
        let cachedConsole
        try {
          cachedConsole = await mcp.callTool(
            'GetConsoleOutput',
            {
              workspaceIdentifier: workspace.id,
              outputType: 'all',
              tailLimit: 500,
              includeMetadata: true,
            },
            { timeoutMs: 30_000, signal: exec.signal },
          )
          consoleCache.set(workspace.id, { value: cachedConsole, cachedAt: Date.now() })
        } catch {
          // No live session; stopping is still useful.
        }
        const value = await mcp.callTool(
          'StopProject',
          { workspaceIdentifier: workspace.id },
          { timeoutMs: 60_000, signal: exec.signal },
        )
        return {
          summary: [
            `${value.stopResult ?? 'Stopped.'}${value.processIdentifier ? ` (PID ${value.processIdentifier})` : ''}`,
            cachedConsole ? 'Saved up to 500 console lines from before stop; use action="console" to read them.' : null,
          ].filter(Boolean).join('\n'),
          action,
          success: true,
          processIdentifier: value.processIdentifier,
          consoleCached: Boolean(cachedConsole),
          notes: cachedConsole ? ['Console snapshot captured before stop.'] : [],
        }
      }

      if (action === 'console') {
        const tailLimit = Math.min(Math.max(Number(args.tailLimit) || 200, 1), 2_000)
        const processFilter = args.process ? String(args.process).toLowerCase() : ''
        const subsystemFilter = args.subsystem ? String(args.subsystem).toLowerCase() : ''
        const hasFilter = Boolean(processFilter || subsystemFilter)
        let value
        let consoleCached = false
        const notes = []
        try {
          value = await mcp.callTool(
            'GetConsoleOutput',
            {
              workspaceIdentifier: workspace.id,
              outputType: args.outputType || 'all',
              tailLimit,
              ...(args.pattern ? { pattern: args.pattern } : {}),
              ...(Number.isFinite(Number(args.contextLines)) ? { contextLines: Number(args.contextLines) } : {}),
              ...(args.includeMetadata === true || hasFilter ? { includeMetadata: true } : {}),
              ...(args.launchSessionReference ? { launchSessionReference: args.launchSessionReference } : {}),
            },
            { timeoutMs: 120_000, signal: exec.signal },
          )
          consoleCache.set(workspace.id, { value, cachedAt: Date.now() })
        } catch (error) {
          const cached = consoleCache.get(workspace.id)
          if (!cached) {
            if (/launch session|find launch/i.test(String(error.message))) {
              throw new Error(
                `${error.message}\n\nXcode has expired the launch session. Call xcode_run action="console" before action="stop", or rerun the app; the plugin now snapshots up to 500 lines before stop.`,
              )
            }
            throw error
          }
          value = cached.value
          consoleCached = true
          notes.push('Console came from the bounded snapshot captured before stop.')
        }
        const rawUnits = consoleCached
          ? (Array.isArray(value.units) ? value.units : []).slice(-tailLimit)
          : Array.isArray(value.units)
            ? value.units
            : []
        const units = hasFilter
          ? rawUnits.filter((unit) => {
              if (unit.kind !== 'oslog') return true
              const metadata = unit.metadata ?? {}
              const processHaystack = `${metadata.processName ?? ''}\n${unit.content ?? ''}`.toLowerCase()
              if (processFilter && !processHaystack.includes(processFilter)) return false
              if (subsystemFilter && !String(metadata.subsystem ?? '').toLowerCase().includes(subsystemFilter)) return false
              return true
            })
          : rawUnits
        const lines = []
        for (const unit of units) {
          const prefix = unit.kind === 'oslog' ? `[oslog${unit.severity ? `:${unit.severity}` : ''}] ` : ''
          const content = String(unit.content ?? '')
          lines.push(`${prefix}${content}`)
        }
        const outputText = lines.join('\n')
        const summaryLines = [
          `Console: ${value.launchSessionInfo ?? 'launch session'}${consoleCached ? ' (cached before stop)' : ''}`,
          `Lines: ${units.length}${hasFilter ? ` of ${value.totalCount ?? rawUnits.length} after filter` : ''}${value.truncated ? ` (truncated to last ${tailLimit})` : ''}`,
          hasFilter
            ? `Filter: process=${JSON.stringify(args.process ?? '')} subsystem=${JSON.stringify(args.subsystem ?? '')}`
            : null,
          outputText || '(no console output yet)',
          ...notes,
        ].filter(Boolean)
        return {
          summary: clip(summaryLines.join('\n'), MAX_TEXT),
          action,
          success: true,
          output: clip(outputText, MAX_TEXT),
          launchSessionInfo: value.launchSessionInfo,
          consoleTruncated: Boolean(value.truncated),
          consoleCached,
          notes,
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

function parseTemplateList(text) {
  const templates = []
  let current
  const value = (line) => line.slice(line.indexOf(':') + 1).trim()
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('TEMPLATE_IDENTIFIER: ')) {
      if (current) templates.push(current)
      current = {
        identifier: value(line),
        name: '',
        templateCategory: undefined,
        platforms: [],
        isMultiPlatform: false,
        options: [],
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('TEMPLATE_NAME: ')) current.name = value(line)
    else if (line.startsWith('TEMPLATE_CATEGORY: ')) current.templateCategory = value(line) || undefined
    else if (line.startsWith('IS_MULTI_PLATFORM: ')) current.isMultiPlatform = value(line) === 'true'
    else if (line.startsWith('PLATFORM: ')) {
      const platform = value(line)
      if (platform) current.platforms.push(platform)
    } else if (line.startsWith('OPTION_IDENTIFIER: ')) {
      current.option = { identifier: value(line), type: '', name: '', defaultValue: '', possibleValues: [] }
      current.options.push(current.option)
    } else if (line.startsWith('OPTION_NAME: ') && current.option) current.option.name = value(line)
    else if (line.startsWith('OPTION_TYPE: ') && current.option) current.option.type = value(line)
    else if (line.startsWith('OPTION_DEFAULT_VALUE: ') && current.option) {
      current.option.defaultValue = value(line)
    } else if (line.startsWith('OPTION_POSSIBLE_VALUES: ') && current.option) {
      const possible = value(line)
      current.option.possibleValues = possible ? possible.split(',').map((item) => item.trim()).filter(Boolean) : []
    }
  }
  if (current) templates.push(current)
  return templates
}

function makeProjectTool(mcp) {
  return {
    name: 'xcode_project',
    description:
      'Discover official Xcode project templates and create a new .xcodeproj from one, then open it. Actions: templates (list/filter project templates; set template to inspect one template’s options), create (create a project at an absolute destination and open the result). This tool does not edit an existing project. Xcode must be running; creating a project may trigger Xcode’s agent-folder approval.',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['templates', 'create'],
        description: 'templates | create',
      },
      path: {
        type: 'string',
        description:
          'For create: absolute destination directory. Xcode creates a <name>/ directory containing the .xcodeproj.',
      },
      name: {
        type: 'string',
        description: 'For create: productName / project name.',
      },
      template: {
        type: 'string',
        description:
          'For create: required template identifier (e.g. com.apple.dt.unit.cocoaApplication). For templates: optional identifier/name filter and requests option details.',
      },
      organization: {
        type: 'string',
        description:
          'For create: optional organization identifier prefix, e.g. com.example.',
      },
      platform: {
        type: 'string',
        description:
          'For templates: optional platform filter, e.g. com.apple.platform.macosx.',
      },
      nameFilter: {
        type: 'string',
        description: 'For templates: optional template name filter.',
      },
      options: {
        type: 'array',
        description:
          'For create: optional template options as key/value strings, e.g. [{key:"testingSystem",value:"Swift Testing"}]. Omit to use template defaults.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true },
            value: { type: 'string', required: true },
          },
        },
      },
    }),
    output: textOutput(
      outputSchema({
        action: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        success: { type: 'boolean', required: true },
        templates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              identifier: { type: 'string', required: true },
              name: { type: 'string', required: true },
              category: { type: 'string' },
              platforms: { type: 'array', items: { type: 'string' } },
              optionIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        templateDetails: {
          type: 'object',
          additionalProperties: false,
          properties: {
            identifier: { type: 'string', required: true },
            name: { type: 'string', required: true },
            category: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  type: { type: 'string' },
                  name: { type: 'string' },
                  defaultValue: { type: 'string' },
                  possibleValues: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        totalTemplates: { type: 'integer' },
        truncated: { type: 'boolean' },
        fullListPath: { type: 'string' },
        projectPath: { type: 'string' },
        createdTargets: { type: 'array', items: { type: 'string' } },
        workspace: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            path: { type: 'string' },
          },
        },
        activeScheme: { type: 'string' },
        activeDestination: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      }),
    ),
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: args.action === 'create' ? `Create Xcode project${args.name ? `: ${args.name}` : ''}` : 'List Xcode templates',
        kind: 'execute',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      if (action === 'templates') {
        const raw = await mcp.callToolRaw(
          'XcodeListTemplates',
          { kind: 'project' },
          { timeoutMs: 120_000, signal: exec.signal },
        )
        let value = raw.value
        // Some Xcode MCP versions omit the per-template `options` array from
        // structuredContent while retaining it in the textual JSON payload.
        try {
          const parsed = JSON.parse(raw.content)
          if (parsed && Array.isArray(parsed.templates)) value = { ...value, ...parsed }
        } catch {
          // The textual content was not JSON; keep structuredContent.
        }
        if (value.fullTemplateListPath) {
          try {
            const parsedList = parseTemplateList(await readFile(String(value.fullTemplateListPath), 'utf8'))
            if (parsedList.length) value = { ...value, templates: parsedList }
          } catch {
            // The host is not allowed to read the artifact file; use the RPC payload.
          }
        }
        const rawTemplates = Array.isArray(value.templates) ? value.templates : []
        const platformNeedle = args.platform ? String(args.platform).toLowerCase() : ''
        const nameNeedle = args.nameFilter ? String(args.nameFilter).toLowerCase() : ''
        const filteredTemplates = rawTemplates.filter((template) => {
          if (platformNeedle) {
            const platforms = Array.isArray(template.platforms)
              ? template.platforms.map((item) => String(item).toLowerCase())
              : []
            const match = platforms.some((item) => item.includes(platformNeedle) || platformNeedle.includes(item))
            if (!match && template.isMultiPlatform !== true) return false
          }
          if (nameNeedle) {
            const label = String(template.name ?? template.templateName ?? '').toLowerCase()
            if (!label.includes(nameNeedle)) return false
          }
          return true
        })
        const templates = filteredTemplates.slice(0, 60).map((template) => ({
          identifier: String(template.identifier ?? ''),
          name: String(template.name ?? template.templateName ?? template.identifier ?? ''),
          category: template.templateCategory ? String(template.templateCategory) : undefined,
          platforms: Array.isArray(template.platforms)
            ? template.platforms.map((item) => String(item)).filter((item) => item !== '(any)')
            : [],
          optionIds: Array.isArray(template.options)
            ? template.options.map((option) => String(option.identifier ?? '')).filter(Boolean)
            : [],
        }))
        let templateDetails
        if (args.template) {
          const requested = String(args.template).toLowerCase()
          const match = rawTemplates.find(
            (template) =>
              String(template.identifier).toLowerCase() === requested ||
              String(template.templateName).toLowerCase() === requested,
          )
          if (match) {
            templateDetails = {
              identifier: String(match.identifier),
              name: String(match.name ?? match.templateName ?? match.identifier),
              category: match.templateCategory ? String(match.templateCategory) : undefined,
              options: Array.isArray(match.options)
                ? match.options.map((option) => ({
                    id: String(option.identifier ?? ''),
                    type: option.type ? String(option.type) : undefined,
                    name: option.name ? String(option.name) : undefined,
                    defaultValue:
                      option.defaultValue === undefined ? undefined : String(option.defaultValue),
                    possibleValues: Array.isArray(option.possibleValues)
                      ? option.possibleValues.map((item) => String(item))
                      : undefined,
                  }))
                : [],
            }
          }
        }
        const notes = []
        if (args.template && !templateDetails) {
          notes.push(`No template matched ${JSON.stringify(String(args.template))}.`)
        }
        const lines = [
          `Project templates (${filteredTemplates.length})${args.platform ? ` on ${args.platform}` : ''}${args.nameFilter ? ` matching ${JSON.stringify(String(args.nameFilter))}` : ''}:`,
          ...templates.slice(0, 25).map(
            (template) =>
              `- ${template.identifier} — ${template.name}${template.platforms?.length ? ` [${template.platforms.join(', ')}]` : ''}`,
          ),
          templates.length > 25 ? `… ${templates.length - 25} more in this page` : null,
          templateDetails
            ? [
                `Template options for ${templateDetails.identifier}:`,
                ...(templateDetails.options ?? []).map(
                  (option) =>
                    `- ${option.id} (${option.type ?? 'option'})${option.defaultValue !== undefined ? ` default=${JSON.stringify(option.defaultValue)}` : ''}${option.possibleValues?.length ? ` values=${option.possibleValues.map((item) => JSON.stringify(item)).join('|')}` : ''}`,
                ),
              ].join('\n')
            : null,
          'Use action="create" with template/path/name. Set template on this action to inspect its options.',
          value.fullTemplateListPath ? `Full template list: ${value.fullTemplateListPath}` : null,
          ...notes,
        ].filter(Boolean)
        return {
          action,
          summary: lines.join('\n'),
          success: true,
          templates,
          templateDetails,
          totalTemplates: filteredTemplates.length,
          truncated: Boolean(value.truncated) || filteredTemplates.length > 60,
          fullListPath: value.fullTemplateListPath,
          notes,
        }
      }

      if (action === 'create') {
        if (!args.path) throw new Error('xcode_project action="create" requires path=<absolute destination directory>.')
        if (!isAbsolute(args.path)) throw new Error('path must be an absolute destination directory.')
        if (!args.name) throw new Error('xcode_project action="create" requires name=<product name>.')
        if (!args.template) throw new Error('xcode_project action="create" requires template=<template identifier>.')
        const destinationPath = resolve(args.path)
        const existing = await stat(destinationPath).catch(() => null)
        if (existing && !existing.isDirectory()) {
          throw new Error(`Destination is not a directory: ${destinationPath}`)
        }
        if (!existing) await mkdir(destinationPath, { recursive: true })

        const options = {}
        if (Array.isArray(args.options)) {
          for (const option of args.options) {
            if (!option || !option.key) throw new Error('Each options entry requires key and value.')
            const key = String(option.key)
            if (Object.hasOwn(options, key)) throw new Error(`Duplicate template option key: ${key}`)
            options[key] = String(option.value ?? '')
          }
        }

        const created = await mcp.callTool(
          'XcodeNewProject',
          {
            templateIdentifier: String(args.template),
            productName: String(args.name),
            destinationPath,
            ...(args.organization ? { organizationIdentifier: String(args.organization) } : {}),
            ...(Object.keys(options).length ? { options } : {}),
          },
          { timeoutMs: 300_000, signal: exec.signal },
        )
        const projectPath = String(created.projectPath ?? '')
        if (!projectPath) throw new Error('Xcode created no projectPath.')
        const createdTargets = Array.isArray(created.createdTargets)
          ? created.createdTargets.map((item) => String(item))
          : []
        const notes = []
        let workspace
        let activeScheme
        let activeDestination
        try {
          const opened = await mcp.callTool(
            'XcodeOpenWorkspace',
            { path: projectPath },
            { timeoutMs: 180_000, signal: exec.signal },
          )
          workspace = { id: String(opened.workspaceIdentifier), path: opened.workspacePath ? String(opened.workspacePath) : projectPath }
          activeScheme = opened.activeScheme ? String(opened.activeScheme) : undefined
          activeDestination = opened.activeRunDestination ? String(opened.activeRunDestination) : undefined
        } catch (error) {
          notes.push(`Project created but could not open it: ${error.message}`)
        }
        const lines = [
          `Created ${args.name} at ${projectPath}`,
          `Targets: ${createdTargets.length ? createdTargets.join(', ') : args.template}`,
          workspace ? `Workspace: ${workspace.id}` : null,
          activeScheme ? `Scheme: ${activeScheme}` : null,
          activeDestination ? `Destination: ${activeDestination}` : null,
          ...notes,
        ].filter(Boolean)
        return {
          action,
          summary: lines.join('\n'),
          success: true,
          projectPath,
          createdTargets,
          workspace,
          activeScheme,
          activeDestination,
          notes,
        }
      }

      throw new Error(`Unknown xcode_project action: ${action}`)
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
    makeProjectTool(mcp),
    makeBuildTool(ctx, mcp),
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
