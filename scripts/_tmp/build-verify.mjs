import { buildSync } from 'esbuild'
buildSync({ entryPoints: ['scripts/_tmp/verify-render.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'scripts/_tmp/verify-render.cjs', external: ['electron', 'better-sqlite3-multiple-ciphers'] })
console.log('bundled')
