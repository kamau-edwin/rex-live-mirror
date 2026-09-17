#!/usr/bin/env node

/**
 * Bundles every tests/src/*-shim.mts entry point into tests/src/build/*.bundle.js
 * for Playwright fixture pages to load as a <script type="module"> tag.
 * Uses esbuild to produce a single browser-compatible bundle per shim.
 */

import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join, basename } from 'path'
import { readdirSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const srcDir = join(__dirname, '../src')
const outDir = join(srcDir, 'build')

const shims = readdirSync(srcDir).filter((f) => f.endsWith('-shim.mts'))

if (shims.length === 0) {
  console.error('❌ No *-shim.mts entry points found in', srcDir)
  process.exit(1)
}

try {
  for (const shim of shims) {
    const inputFile = join(srcDir, shim)
    const outputFile = join(outDir, basename(shim, '.mts') + '.bundle.js')

    await esbuild.build({
      entryPoints: [inputFile],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2021',
      outfile: outputFile,
      sourcemap: true,
    })

    console.log(`✅ Bundle created: ${outputFile}`)
  }

  console.log('   You can now run: npm test')
} catch (error) {
  console.error('❌ Build failed:', error)
  process.exit(1)
}
