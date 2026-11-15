import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
const prod = process.argv[2] === 'production';
// CSL styles and locales ship as text; comments and indentation are stripped to keep main.js small.
const xmlText = { name: 'xml-text', setup(b) { b.onLoad({ filter: /\.(csl|xml)$/ }, async (a) => ({ contents: (await readFile(a.path, 'utf8')).replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><'), loader: 'text' })); } };
await esbuild.build({
	entryPoints: ['src/main.ts'], bundle: true, format: 'cjs', target: 'es2021', platform: 'browser', outfile: 'main.js',
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'], plugins: [xmlText], minify: prod, sourcemap: prod ? false : 'inline',
	treeShaking: true, logLevel: 'info', legalComments: 'eof',
});
