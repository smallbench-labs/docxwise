import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const prod = process.argv[2] === 'production';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
// CSL styles and locales ship as text; comments and indentation are stripped to keep main.js small.
const xmlText = { name: 'xml-text', setup(b) { b.onLoad({ filter: /\.(csl|xml)$/ }, async (a) => ({ contents: (await readFile(a.path, 'utf8')).replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><'), loader: 'text' })); } };
// License notices travel with main.js: a short header at the top, the full THIRD_PARTY_NOTICES.md at the end.
// jszip pulls in two old polyfills that build <script> elements at runtime ("lie" -> "immediate", and
// "setimmediate", which also has new Function), plus Node's readable-stream. Obsidian has native Promise and a modern scheduler,
// so both are swapped for small shims in src/shims (see the comments there).
const shims = { name: 'shims', setup(b) {
	const local = (rel) => fileURLToPath(new URL(rel, import.meta.url));
	// jszip's "browser" field points at its prebuilt dist/jszip.min.js, which has both polyfills baked in.
	// Bundle jszip from its lib/ sources instead so the two requires below can be swapped.
	b.onResolve({ filter: /^jszip$/ }, () => ({ path: local('./node_modules/jszip/lib/index.js') }));
	b.onResolve({ filter: /^(lie|setimmediate|readable-stream)$/ }, (a) => ({ path: local(`./src/shims/${a.path}.ts`) }));
} };
const notices = (await readFile('THIRD_PARTY_NOTICES.md', 'utf8')).replace(/\*\//g, '* /');
const banner = `/*! Docxwise ${manifest.version} - Copyright (c) 2026 Smallbench Labs (Roger Chang) - MIT License.
 * This file also contains third-party software under its own licenses (MIT, BSD-2-Clause, BSD-3-Clause, Zlib,
 * CPAL-1.0) and CSL styles under CC BY-SA 3.0. The full notices are at the end of this file.
 * CPAL-1.0: the Source Code version of citeproc-js 2.4.63 (bundled unmodified) is available under the terms of
 * CPAL-1.0; where and how is described in the notices at the end of this file. */`;
await esbuild.build({
	entryPoints: ['src/main.ts'], bundle: true, format: 'cjs', target: 'es2021', platform: 'browser', outfile: 'main.js',
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'], plugins: [shims, xmlText], minify: prod, sourcemap: prod ? false : 'inline',
	treeShaking: true, logLevel: 'info', legalComments: 'eof',
	banner: { js: banner }, footer: { js: `/*! THIRD_PARTY_NOTICES.md\n\n${notices}\n*/` },
});
