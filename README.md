# Asterism Plugins

This workspace contains companion plugins for internal testing of Asterism's plugin system. Context Fold is the first. The plugins are not published to npm during this phase: clone this repository, build locally, and load the plugin manually in Asterism.

## Local testing

1. Clone this repository next to a compatible Asterism source checkout named `asterism`. This workspace uses the sibling checkout's API and builder. For Context Fold, the host must include the tool-result projection hook.
2. Install dependencies in the Asterism checkout and run `npm run build:plugin-tool` there.
3. In this checkout, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
4. In Asterism's plugin settings, add the built package directory (`plugins/context-fold` for Context Fold), then restart Asterism.
