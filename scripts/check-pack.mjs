import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['run', 'prepack'], {stdio: 'inherit', shell: process.platform === 'win32'})
const output = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
execFileSync(npm, ['run', 'postpack'], {stdio: 'inherit', shell: process.platform === 'win32'})
const [pack] = JSON.parse(output)
const files = pack.files.map(file => file.path)
for (const required of ['bin/run.js', 'dist/index.js', 'package.json', 'README.md', 'LICENSE', 'NOTICE']) {
  if (!files.includes(required)) throw new Error(`Package missing ${required}`)
}
if (files.some(path => /^(src|test|docs|\.github)\//.test(path))) throw new Error('Unexpected source files in package')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (Object.keys(pkg.bin).join() !== 'ledgerops') throw new Error('Unexpected executable alias')
console.log(`Verified ${files.length} package files`)
