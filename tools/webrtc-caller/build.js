// Bundles page/entry.js -> page/bundle.js (browser IIFE).
// The Chime SDK drags in @smithy node-http packages (only used by its
// messaging feature); alias node builtins to an empty shim for the browser.
const esbuild = require('esbuild');
const path = require('path');

// build/task/PromoteToPrimaryMeetingTask.js does require("..") which would pull
// the whole package index (messaging client + AWS SDK + node builtins) into the
// browser bundle; redirect it to a two-export shim.
const indexShim = {
  name: 'chime-index-shim',
  setup(b) {
    b.onResolve({ filter: /^\.\.$/ }, (args) => {
      if (args.importer.includes('amazon-chime-sdk-js')) {
        return { path: path.join(__dirname, 'page', 'chime-index-shim.js') };
      }
      return undefined;
    });
  },
};

esbuild.build({
  entryPoints: [path.join(__dirname, 'page', 'entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: path.join(__dirname, 'page', 'bundle.js'),
  plugins: [indexShim],
  define: { global: 'globalThis' },
  logLevel: 'info',
}).catch((e) => { console.error(e); process.exit(1); });
