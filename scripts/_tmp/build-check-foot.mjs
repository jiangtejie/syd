import { buildSync } from 'esbuild'
buildSync({ entryPoints: ['scripts/_tmp/check-foot.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'scripts/_tmp/check-foot.cjs', external: ['electron', 'better-sqlite3-multiple-ciphers'] })
console.log('bundled')
