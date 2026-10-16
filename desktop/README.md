# Desktop packaging

Whole Brain Simulation runs the existing engine in an Electron window.
`brain://app` serves only built files under `dist/`. It preserves absolute
asset paths and worker origins without a listening HTTP server. The renderer
is sandboxed, isolated, and has no Node bridge. Permissions and remote
HTTP/WebSocket traffic are denied. Help opens locally; explicit source links
to the project's GitHub namespace open in the system browser.

Build with Node 22.16+ or Node 24 LTS:

```
npm ci
npm run desktop
npm test
npm run test:desktop
npm run test:app
npm run package
```

The source lockfile pins the complete toolchain. Astro and the packager are
development dependencies and are not copied into the installed app.
The numerical engine is unchanged by desktop packaging.

`npm run package` produces a Mac DMG/ZIP, Windows NSIS installer, or Linux
AppImage in `release/` on the corresponding host. The default architecture
is the build host's. Use `npm run package:mac -- --x64` for Intel or
`npm run package:mac -- --arm64` for Apple Silicon. Each architecture needs
its own installed-app check.

`.github/workflows/desktop.yml` builds on all three native runners when
manually dispatched or when a `desktop-v*` tag is pushed. It tests the
engine, protocol boundary, and desktop UI before uploading development
installers as workflow artifacts. It does not publish a GitHub release.

The smoke test runs Awake and Seizure, checks the readouts, confirms a worker
exists and Node access is absent, verifies a remote fetch is blocked, and
opens bundled help. To run it on a packaged executable:

```
BRAIN_EXECUTABLE='/path/to/Whole Brain Simulation.app/Contents/MacOS/Whole Brain Simulation' node desktop/smoke.mjs
```

On Linux CI use `xvfb-run --auto-servernum npm run test:app`.

For public distribution configure signing outside this repository. A Mac
release needs Developer ID signing and notarization; Windows signing
establishes publisher identity. The provided workflow creates unsigned
builds and must not be described as a signed release. Do not disable OS
security controls as an installation step.

Manually verify the installed app with the network disconnected: both
presets render, the numerical readout updates, and Help loads with fonts.
Keep the built engine, worker, and assets in one installer.
