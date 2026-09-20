import { buildSync } from 'esbuild'
buildSync({
  entryPoints: ['scripts/_tmp/render-list-cover.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/_tmp/render-list-cover.cjs',
  external: ['electron', 'better-sqlite3-multiple-ciphers']
})
console.log('bundled')
