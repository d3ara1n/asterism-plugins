# Asterism Plugins

An npm workspace for optional Asterism plugins. Context Fold is the first package.

## Develop

Keep this checkout beside the Asterism source checkout named asterism. The workspace uses the local API and builder while the projection hook is unreleased. Install the Asterism checkout's dependencies and run its npm run build:plugin-tool first. Then run npm ci, npm run typecheck, npm test, and npm run build in this workspace.

Add the built package directory in Asterism's plugin settings and restart to try it locally. The tested host must include the tool result projection hook. The files built into the distributable package do not depend on either checkout's location.
