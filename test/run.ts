import * as fs from 'fs';
import * as path from 'path';
import { Converter, VaultHost } from '../src/core/convert';
import { parseBibtex } from '../src/core/bibtex';

const vault = path.resolve(__dirname, '../test-vault');
const outDir = path.resolve(__dirname, '../out');
fs.mkdirSync(outDir, { recursive: true });
const all: string[] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : all.push(path.relative(vault, p)); } };
walk(vault);

const host: VaultHost = {
	async readText(p) { try { return fs.readFileSync(path.join(vault, p), 'utf8'); } catch { return null; } },
	async readBinary(p) { try { const b = fs.readFileSync(path.join(vault, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch { return null; } },
	resolve(link, from) {
		const withExt = /\.\w+$/.test(link) ? link : link + '.md';
		if (link.includes('/') || link.startsWith('.')) {
			const p = path.normalize(path.join(path.dirname(from), withExt));
			if (all.includes(p)) return p;
		}
		return all.find((f) => f === withExt) ?? all.find((f) => path.basename(f) === path.basename(withExt)) ?? null;
	},
};

const asset = (f: string) => fs.readFileSync(path.resolve(__dirname, '../assets', f), 'utf8');
const items = new Map(parseBibtex(fs.readFileSync(path.join(vault, 'refs.bib'), 'utf8')).map((i) => [i.id, i]));

async function run(style: string, title: string, out: string, extra: Record<string, unknown> = {}) {
	const note = 'Notes/Research Paper.md';
	const c = new Converter(host, { page: 'A4', breaks: true, title: 'auto', pageNumbers: true, wikilinks: 'text', bibliography: { items, styleXml: asset(style), localeXml: asset('locales-en-US.xml'), title }, ...extra });
	const t0 = Date.now();
	const r = await c.convert(fs.readFileSync(path.join(vault, note), 'utf8'), note, 'Research Paper');
	fs.writeFileSync(path.join(outDir, out), r.data);
	console.log(out, r.data.length, 'bytes', Date.now() - t0, 'ms', 'warnings:', r.warnings);
}

(async () => {
	await run('apa.csl', 'References', 'research-apa.docx');
	await run('chicago-notes-bibliography.csl', 'Bibliography', 'research-chicago-notes.docx', { page: 'Letter' });
	if (fs.existsSync(path.join(outDir, 'template.docx'))) {
		const b = fs.readFileSync(path.join(outDir, 'template.docx'));
		await run('chicago-author-date.csl', 'References', 'research-template.docx', { template: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
	}
})().catch((e) => { console.error(e); process.exit(1); });

(async () => {
	await new Promise((r) => setTimeout(r, 3000));
	const items2 = items;
	const note = 'Notes/Edge Cases.md';
	const c = new Converter(host, { page: 'A4', breaks: true, title: 'auto', pageNumbers: true, wikilinks: 'text', bibliography: { items: items2, styleXml: asset('apa.csl'), localeXml: asset('locales-en-US.xml'), title: 'References' } });
	const r = await c.convert(fs.readFileSync(path.join(vault, note), 'utf8'), note, 'Edge Cases');
	fs.writeFileSync(path.join(outDir, 'edge-cases.docx'), r.data);
	console.log('edge-cases.docx', r.data.length, 'warnings:', r.warnings);
	// performance: a long note (~600 paragraphs, 300 equations, 150 citations)
	let big = '# Long note\n\n';
	for (let i = 0; i < 150; i++) big += `## Section ${i}\n\nParagraph ${i} with $a_${i} = \\frac{${i}}{2}$ and a citation [@tversky1974, p. ${i + 1}].\n\n$$\\sum_{k=1}^{${i + 1}} k^2$$\n\n- item one\n- item two\n\n`;
	const c2 = new Converter(host, { page: 'A4', breaks: true, title: 'auto', pageNumbers: true, wikilinks: 'text', bibliography: { items: items2, styleXml: asset('apa.csl'), localeXml: asset('locales-en-US.xml'), title: 'References' } });
	const t0 = Date.now();
	const r2 = await c2.convert(big, 'Long.md', 'Long');
	fs.writeFileSync(path.join(outDir, 'long-note.docx'), r2.data);
	console.log('long-note.docx', r2.data.length, 'bytes', Date.now() - t0, 'ms');
})();

(async () => {
	await new Promise((r) => setTimeout(r, 6000));
	const b = fs.readFileSync(path.join(outDir, 'template.docx'));
	const c = new Converter(host, { page: 'Letter', breaks: true, title: 'auto', pageNumbers: true, wikilinks: 'text', template: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), bibliography: { items, styleXml: asset('apa.csl'), localeXml: asset('locales-en-US.xml'), title: 'References' } });
	const notes = ['Notes/Methods.md', 'Glossary.md', 'Notes/Edge Cases.md'].map((p) => ({ markdown: fs.readFileSync(path.join(vault, p), 'utf8'), path: p, title: path.basename(p, '.md') }));
	const r = await c.convertMany(notes);
	fs.writeFileSync(path.join(outDir, 'merged-pro.docx'), r.data);
	console.log('merged-pro.docx', r.data.length, 'warnings:', r.warnings.length);
})();
