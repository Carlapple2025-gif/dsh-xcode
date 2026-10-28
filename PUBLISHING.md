# Publishing `dsh-xcode`

This repository ships one npm package from [`plugin/`](plugin/). It is a DSH
bundle, not a standalone CLI.

## 1. Verify

```bash
cd plugin
npm run check
```

Expected: six tools, all parameter roots are `type: "object"`, and
`xcode_build.pattern` is `{ "type": "string" }`.

End-to-end Xcode verification is documented in [README.md](README.md).

## 2. Build the distributable tarball

```bash
cd plugin
npm pack --pack-destination dist
```

`prepack` runs `npm run check` automatically. The output is:

```text
dist/dsh-xcode-<version>.tgz
```

Inspect it without installing:

```bash
tar -tzf dist/dsh-xcode-0.2.0.tgz
```

The tarball must contain `package.json`, `index.js`, `cordis.patch.yml`,
`locale/*.json`, `icon.svg`, `README.md`, `LICENSE`, `CHANGELOG.md`, and
`scripts/check-schemas.mjs`.

## 3. Install from the tarball

In DSH:

```text
plugin_manager install_bundle
  target: /absolute/path/to/dist/dsh-xcode-0.2.0.tgz
```

or install from the npm registry after publishing:

```text
plugin_manager install_bundle
  target: dsh-xcode@0.2.0
```

Then call `xcode_context` with `action: "status"`.

## 4. Publish to npm

The package name `dsh-xcode` is unscoped and currently available. Publishing
is intentionally not automated here.

```bash
npm login
npm publish --access public
```

The package publishes only the files listed in `plugin/package.json#files`;
it has no dependencies and no install scripts.

## 5. Tag the release

```bash
git add .
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "dsh-xcode v0.2.0"
git push origin main --tags
```

## Versioning

Follow semver:

- patch: schema/output fixes, new Xcode MCP compatibility
- minor: new tool or new action
- major: breaking tool names, parameter semantics, or DSH contract

Update `plugin/CHANGELOG.md` and `plugin/package.json` together.
