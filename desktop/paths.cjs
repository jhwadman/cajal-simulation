const path = require('node:path');
function bundledPath(root, address) {
  const url = new URL(address);
  if (url.protocol !== 'brain:' || url.host !== 'app' || url.username || url.password) throw new Error('Invalid origin');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw new Error('Invalid path');
  let file = path.resolve(root, '.' + pathname);
  if (!path.extname(file)) file = path.join(file, 'index.html');
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside bundle');
  return file;
}
module.exports = { bundledPath };
