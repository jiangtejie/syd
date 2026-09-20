import { buildSync } from 'esbuild'
buildSync({ entryPoints: ['scripts/_tmp/probe-cdp-capture.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'scripts/_tmp/probe-cdp-capture.cjs', external: ['electron', 'better-sqlite3-multiple-ciphers'] })
console.log('bundled')
