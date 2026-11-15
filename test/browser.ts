// Runs the converter inside Chrome (no Node APIs) to prove the core works in a browser/mobile-like runtime.
import { Converter, VaultHost } from '../src/core/convert';
import { parseBibtex } from '../src/core/bibtex';
import { STYLES, LOCALE_EN_US } from '../src/styles';
declare const VAULT: Record<string, string>; // path -> base64
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
const files = Object.keys(VAULT);
const host: VaultHost = {
	async readText(p) { return VAULT[p] ? new TextDecoder().decode(b64(VAULT[p])) : null; },
	async readBinary(p) { return VAULT[p] ? b64(VAULT[p]) : null; },
	resolve(link, from) {
		const withExt = /\.\w+$/.test(link) ? link : link + '.md';
		if (link.startsWith('.')) { const parts: string[] = []; for (const s of (from.split('/').slice(0, -1).join('/') + '/' + withExt).split('/')) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); } const p = parts.join('/'); if (VAULT[p]) return p; }
		return files.find((f) => f === withExt) ?? files.find((f) => f.split('/').pop() === withExt.split('/').pop()) ?? null;
	},
};
(async () => {
	try {
		const items = new Map(parseBibtex((await host.readText('refs.bib'))!).map((i) => [i.id, i]));
		const c = new Converter(host, { page: 'A4', breaks: true, title: 'auto', pageNumbers: true, wikilinks: 'text', bibliography: { items, styleXml: STYLES['chicago-author-date'].xml, localeXml: LOCALE_EN_US, title: 'References' } });
		const r = await c.convert((await host.readText('Notes/Research Paper.md'))!, 'Notes/Research Paper.md', 'Research Paper');
		let s = ''; for (let i = 0; i < r.data.length; i += 0x8000) s += String.fromCharCode(...r.data.subarray(i, i + 0x8000));
		document.body.textContent = 'DOCX:' + btoa(s);
	} catch (e) { document.body.textContent = 'ERR:' + (e as Error).stack; }
})();
