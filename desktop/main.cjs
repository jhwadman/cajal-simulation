const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { bundledPath } = require('./paths.cjs');
const ORIGIN = 'brain://app';
protocol.registerSchemesAsPrivileged([{ scheme: 'brain', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('Whole Brain Simulation');
const local = (url) => { try { return new URL(url).protocol === 'brain:' && new URL(url).host === 'app'; } catch { return false; } };
function follow(url) {
  if (local(url)) createWindow(url);
  else if (url.startsWith('https://github.com/jhwadman/')) void shell.openExternal(url);
}
function createWindow(url = ORIGIN + '/') {
  const win = new BrowserWindow({ width: 1440, height: 960, minWidth: 850, minHeight: 620, backgroundColor: '#06080c', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { follow(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!local(url)) { event.preventDefault(); follow(url); } });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  void win.loadURL(url);
  return win;
}
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  protocol.handle('brain', async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    try {
      const file = bundledPath(path.join(app.getAppPath(), 'dist'), request.url);
      const response = await net.fetch(pathToFileURL(file).href);
      if (!file.endsWith('.html')) return response;
      const html = await response.text();
      const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'` } });
    } catch { return new Response('Bundled file not found', { status: 404 }); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ label: 'New simulation window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'How it works', click: () => createWindow(ORIGIN + '/how-it-works/') }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
