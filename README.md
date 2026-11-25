# Asterism Plugins

This workspace contains official companion plugins for Asterism. Clone this repository, build locally, and load the plugin manually in Asterism.

## Local testing

1. Install [Asterism v1.1.0-prerelease.7](https://github.com/d3ara1n/asterism/releases/tag/v1.1.0-prerelease.7), or a later release compatible with its plugin APIs. The workspace pins the SDK, builtin API, and builder versions listed in the release notes. No Asterism source checkout is required.
2. From this repository, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
3. In Asterism's plugin settings, add the `plugins/apply-patch` package directory, then restart Asterism.

## Plugins

- [Apply Patch](plugins/apply-patch/README.md): freeform Directory writes and diff receipts.
