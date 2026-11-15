// Citations via citeproc-js (CPAL-1.0, bundled unmodified) + CSL styles.
import CSL from 'citeproc';
import type { CslEngine } from 'citeproc';
import type { CiteItem } from './markdown';
import type { CslItem } from './bibtex';
import { decodeEntities } from './xml';

export interface Seg { text: string; i?: boolean; b?: boolean; sc?: boolean; sup?: boolean; sub?: boolean }

export function htmlToSegs(html: string): Seg[] {
	const segs: Seg[] = [];
	const st = { i: 0, b: 0, sc: 0, sup: 0, sub: 0 };
	const stack: string[] = [];
	const re = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[4] !== undefined) {
			const t = decodeEntities(m[4]).replace(/\n/g, '');
			if (t) segs.push({ text: t, i: st.i > 0, b: st.b > 0, sc: st.sc > 0, sup: st.sup > 0, sub: st.sub > 0 });
			continue;
		}
		const tag = m[2].toLowerCase();
		const close = !!m[1];
		let kind = '';
		if (tag === 'i' || tag === 'em') kind = 'i';
		else if (tag === 'b' || tag === 'strong') kind = 'b';
		else if (tag === 'sup') kind = 'sup';
		else if (tag === 'sub') kind = 'sub';
		else if (tag === 'span') kind = /small-caps/.test(m[3]) ? 'sc' : /font-style:\s*normal/.test(m[3]) ? 'ni' : '-';
		if (tag === 'span') {
			if (close) { const k = stack.pop(); if (k && k in st) (st as Record<string, number>)[k]--; if (k === 'ni') st.i++; }
			else { stack.push(kind); if (kind in st) (st as Record<string, number>)[kind]++; if (kind === 'ni') st.i--; }
		} else if (kind) (st as Record<string, number>)[kind] += close ? -1 : 1;
	}
	return segs;
}

interface CslName { literal?: string; family?: string; given?: string }

export interface Cluster { id: string; items: CiteItem[]; narrative: boolean; noteIndex: number }

export class Citer {
	private engine: CslEngine;
	readonly isNote: boolean;
	readonly missing = new Set<string>();
	constructor(private items: Map<string, CslItem>, styleXml: string, localeXml: string) {
		const sys = { retrieveLocale: () => localeXml, retrieveItem: (id: string) => this.items.get(id) };
		this.engine = new CSL.Engine(sys, styleXml);
		this.isNote = this.engine.opt.xclass === 'note';
	}
	has(key: string): boolean { return this.items.has(key); }
	/** "Kahneman", "Tversky and Kahneman", "Smith et al." for narrative citations in note styles. */
	authorName(key: string): string {
		const it = this.items.get(key);
		const names = (v: unknown): CslName[] => (Array.isArray(v) ? (v as CslName[]) : []);
		const a = names(it?.author).length ? names(it?.author) : names(it?.editor);
		const n = (p: CslName) => p.literal ?? p.family ?? '';
		if (!a.length) return typeof it?.title === 'string' ? it.title : key;
		if (a.length === 1) return n(a[0]);
		if (a.length === 2) return `${n(a[0])} and ${n(a[1])}`;
		return `${n(a[0])} et al.`;
	}

	/** Formats all clusters at once so disambiguation, ibid. and "et al." rules are applied across the whole document. */
	format(clusters: Cluster[]): Map<string, Seg[]> {
		const out = new Map<string, Seg[]>();
		const used: string[] = [];
		const csl: object[] = [];
		const narrativeParts: { id: string; author: string; rest: string }[] = [];
		for (const c of clusters) {
			const ok = c.items.filter((it) => { if (!this.items.has(it.key)) { this.missing.add(it.key); return false; } return true; });
			if (!ok.length) { out.set(c.id, [{ text: c.items.map((i) => `@${i.key}`).join('; '), b: true }]); continue; }
			ok.forEach((it) => used.includes(it.key) || used.push(it.key));
			const ci = (it: CiteItem, extra: Record<string, unknown> = {}) => ({ id: it.key, prefix: it.prefix ? it.prefix + ' ' : undefined, suffix: it.suffix ? (/^[,.;:]/.test(it.suffix) ? it.suffix : ', ' + it.suffix) : undefined, locator: it.locator, label: it.label, 'suppress-author': it.suppressAuthor || undefined, ...extra });
			if (c.narrative && !this.isNote) {
				csl.push({ citationID: c.id + 'a', citationItems: [ci(ok[0], { 'author-only': true })], properties: { noteIndex: 0 } });
				csl.push({ citationID: c.id + 'b', citationItems: [ci(ok[0], { 'suppress-author': true })], properties: { noteIndex: 0 } });
				narrativeParts.push({ id: c.id, author: c.id + 'a', rest: c.id + 'b' });
			} else csl.push({ citationID: c.id, citationItems: ok.map((it) => ci(it)), properties: { noteIndex: c.noteIndex } });
		}
		this.engine.updateItems(used);
		const res: [string, number, string][] = csl.length ? this.engine.rebuildProcessorState(csl, 'html') : [];
		const byId = new Map(res.map((r) => [r[0], r[2]]));
		for (const [id, html] of byId) if (!id.endsWith('a') && !id.endsWith('b')) out.set(id, htmlToSegs(html));
		for (const n of narrativeParts) {
			const a = byId.get(n.author) ?? '', b = byId.get(n.rest) ?? '';
			out.set(n.id, [...htmlToSegs(a), { text: ' ' }, ...htmlToSegs(b)]);
		}
		for (const c of clusters) if (!out.has(c.id)) out.set(c.id, htmlToSegs(byId.get(c.id) ?? ''));
		if (this.isNote) for (const segs of out.values()) if (segs[0]?.text) segs[0].text = segs[0].text.charAt(0).toUpperCase() + segs[0].text.slice(1);
		return out;
	}

	bibliography(): { entries: Seg[][]; hanging: boolean; lineSpacing: number; entrySpacing: number } | null {
		const r = this.engine.makeBibliography();
		if (!r) return null;
		const [params, entries] = r;
		return {
			entries: entries.map((e) => htmlToSegs(e.replace(/<div class="csl-left-margin">(.*?)<\/div>/, '$1\t').replace(/<\/?div[^>]*>/g, '').trim())),
			hanging: !!params.hangingindent, lineSpacing: params.linespacing || 1, entrySpacing: params.entryspacing || 0,
		};
	}
}
