const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { bundledPath } = require('./paths.cjs');
const root = path.resolve('dist');
test('routes and assets resolve inside the installed bundle', () => {
  for (const [url, file] of [['/', 'index.html'], ['/how-it-works/', 'how-it-works/index.html'], ['/brain/mesh.bin', 'brain/mesh.bin'], ['/_astro/worker.js', '_astro/worker.js']]) assert.equal(bundledPath(root, 'brain://app' + url), path.join(root, file));
});
test('untrusted origins and encoded traversal cannot read outside the bundle', () => {
  for (const url of ['file:///etc/passwd', 'brain://other/index.html', 'brain://app/%2e%2e%2fsecret', 'brain://app/%5c..%5csecret', 'brain://app/%00secret', 'brain://user@app/index.html']) assert.throws(() => bundledPath(root, url));
});
