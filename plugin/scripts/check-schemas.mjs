#!/usr/bin/env node
/**
 * Smoke check for the model-facing tool contract.
 *
 * `ctx.tools.register` forwards `parameters` to the model API verbatim, so a
 * schema written as a bare property map — or one still carrying an author-only
 * `required: true` marker — breaks every request with HTTP 400 before the model
 * sees a turn. The plugin compiles its authoring form through `parameterSchema`
 * at load; this script registers the real tools against a stub context and
 * asserts what actually reaches the wire.
 *
 * The rules below mirror the enforced JSON Schema subset in
 * `@deepseek-ai/dsh-tools` (which is authoritative); keeping them inline keeps
 * this checker dependency-free. Run with `node scripts/check-schemas.mjs` or
 * `npm run check`.
 */

import { isDeepStrictEqual } from 'node:util'

import { apply } from '../index.js'

const EXPECTED_TOOLS = ['xcode_context', 'xcode_build', 'xcode_test', 'xcode_run', 'xcode_simulator']
const REQUIRED_ACTIONS = ['xcode_context', 'xcode_test', 'xcode_run', 'xcode_simulator']
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const TYPE_ONLY = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])

const violations = []
const fail = (path, message) => violations.push(`${path} ${message}`)

const isRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Validate one schema node against the enforced subset, collecting every violation. */
function checkSchema(node, path, depth = 0) {
  if (depth > 32) return fail(path, 'nests deeper than 32 levels.')
  if (!isRecord(node)) return fail(path, 'must be a schema object.')

  const { type } = node
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  const hasProperties = Object.hasOwn(node, 'properties')
  const hasItems = Object.hasOwn(node, 'items')

  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) {
      fail(`${path}.${key}`, 'is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations).')
    } else if (ANNOTATIONS.has(key) && key !== 'default' && key !== 'examples' && typeof node[key] !== 'string') {
      fail(`${path}.${key}`, 'must be a string.')
    }
  }
  try {
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(node)), node)) {
      fail(path, 'must be lossless JSON (no undefined, functions, symbols, or class instances).')
    }
  } catch {
    fail(path, 'must be serializable JSON.')
  }

  if (hasType && hasOneOf) return fail(path, 'cannot declare both type and oneOf.')

  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      return fail(`${path}.oneOf`, 'must be an array of at least two schemas.')
    }
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) fail(`${path}.${key}`, 'is not supported beside oneOf.')
    }
    return node.oneOf.forEach((child, index) => checkSchema(child, `${path}.oneOf[${index}]`, depth + 1))
  }

  if (!hasType) {
    for (const key of Object.keys(TYPE_ONLY)) {
      if (Object.hasOwn(node, key)) fail(`${path}.${key}`, 'requires an explicit type.')
    }
    return
  }
  if (!SCHEMA_TYPES.includes(type)) {
    return fail(`${path}.type`, `must be a single type string, got ${JSON.stringify(type)}.`)
  }
  for (const [key, types] of Object.entries(TYPE_ONLY)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) {
      fail(`${path}.${key}`, `is not supported on type "${type}".`)
    }
  }

  if (type === 'object') {
    if (hasProperties && !isRecord(node.properties)) {
      fail(`${path}.properties`, 'must map property names to schemas.')
    } else if (hasProperties) {
      for (const [key, child] of Object.entries(node.properties)) {
        checkSchema(child, `${path}.properties.${key}`, depth + 1)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      const { required } = node
      if (!Array.isArray(required)) {
        fail(`${path}.required`, 'must be an array of property names, not an author-DSL boolean.')
      } else {
        const declared = hasProperties ? Object.keys(node.properties) : []
        for (const key of required) {
          if (typeof key !== 'string') fail(`${path}.required`, 'must contain only property names.')
          else if (!declared.includes(key)) fail(`${path}.required`, `names undeclared property ${JSON.stringify(key)}.`)
        }
        if (new Set(required).size !== required.length) fail(`${path}.required`, 'must not repeat a property name.')
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties`, 'must be a boolean.')
    }
  }

  if (type === 'array' && hasItems) checkSchema(node.items, `${path}.items`, depth + 1)

  if (SCALARS.has(type)) {
    if (Object.hasOwn(node, 'enum')) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        fail(`${path}.enum`, 'must be a non-empty array.')
      } else if (node.enum.some((value) => value !== null && typeof value === 'object')) {
        fail(`${path}.enum`, 'must contain only scalar values.')
      }
    }
    if (Object.hasOwn(node, 'const') && node.const !== null && typeof node.const === 'object') {
      fail(`${path}.const`, 'must be a scalar value.')
    }
  }
}

/** Load the plugin against a stub context and return the tools it would register. */
function loadTools() {
  const registered = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    subprocess: {},
  }
  apply(ctx)
  return registered
}

let tools
try {
  tools = loadTools()
} catch (error) {
  console.error(`✗ plugin failed to load: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const names = tools.map((tool) => tool.name)
for (const expected of EXPECTED_TOOLS) {
  if (!names.includes(expected)) fail('tools', `is missing ${expected}.`)
}
for (const name of names) {
  if (names.filter((other) => other === name).length > 1) fail(`tools.${name}`, 'is registered more than once.')
}
if (names.includes('run_code')) fail('tools.run_code', 'is reserved for the code-mode transport.')

for (const tool of tools) {
  const { name, description, parameters, output } = tool
  if (typeof description !== 'string' || description.length === 0) {
    fail(`tools.${name}.description`, 'must be a non-empty string.')
  }
  const rootIsObject = isRecord(parameters) && parameters.type === 'object' && isRecord(parameters.properties)
  if (!isRecord(parameters)) {
    fail(`tools.${name}.parameters`, 'must be a schema object.')
  } else if (!rootIsObject) {
    // A bare property map fails both checks; skip the deep walk so the report stays readable.
    fail(`tools.${name}.parameters`, 'must be an object-rooted schema ({ type: "object", properties }); a bare property map is not JSON Schema.')
  } else {
    checkSchema(parameters, `tools.${name}.parameters`)
    if (REQUIRED_ACTIONS.includes(name)) {
      const required = parameters.required
      if (!Array.isArray(required) || required.length !== 1 || required[0] !== 'action') {
        fail(`tools.${name}.parameters.required`, 'must be ["action"].')
      }
    }
  }
  if (!isRecord(output) || typeof output.render !== 'function') {
    fail(`tools.${name}.output`, 'must declare { schema, render }.')
  } else {
    checkSchema(output.schema, `tools.${name}.output.schema`)
  }
}

const width = Math.max(...tools.map((tool) => tool.name.length), 11)
for (const tool of tools) {
  const root = tool.parameters?.type ?? 'missing'
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : []
  const count = Object.keys(tool.parameters?.properties ?? {}).length
  console.log(`  ${tool.name.padEnd(width)}  root=${root}  properties=${count}  required=${JSON.stringify(required)}`)
}

if (violations.length > 0) {
  console.error(`\n✗ ${violations.length} schema violation(s):`)
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}

console.log(`\n✓ ${tools.length} tools, ${EXPECTED_TOOLS.length} expected, all schemas are object-rooted JSON Schema.`)
