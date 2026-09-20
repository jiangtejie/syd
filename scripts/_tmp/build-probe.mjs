import { buildSync } from 'esbuild'
buildSync({ entryPoints: ['scripts/_tmp/probe-window-size.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'scripts/_tmp/probe-window-size.cjs', external: ['electron'] })
console.log('bundled')
