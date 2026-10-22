/**
 * Build the browser half into the artifact DSH loads.
 *
 * DSH evaluates `exports["./client"]` through
 * `window.__ModuleLoader__.load({ id, factory })`; the factory receives only
 * the shell-owned modules, so React stays external.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const temporary = resolve(root, '.client-build', 'client.cjs')
const output = resolve(root, 'lib', 'client', 'index.js')

await mkdir(dirname(temporary), { recursive: true })
await mkdir(dirname(output), { recursive: true })

const wrap = (compiled) => `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageJson.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${compiled}
    return module.exports;
  },
});
`

const wrapPlugin = {
  name: 'wrap-module-loader',
  setup(buildApi) {
    buildApi.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const compiled = await readFile(temporary, 'utf8')
      await writeFile(`${output}.tmp`, wrap(compiled), 'utf8')
      await rename(`${output}.tmp`, output)
    })
  },
}

await build({
  entryPoints: [resolve(root, 'src', 'client', 'index.tsx')],
  outfile: temporary,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  legalComments: 'none',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-slots'],
  plugins: [wrapPlugin],
})
console.log(`built ${output}`)
