import {
	AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, FootnoteReferenceRun, HeadingLevel, ImageRun, LevelFormat,
	Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType, ParagraphChild, IParagraphOptions, IRunOptions, TableLayoutType,
} from 'docx';
import type { Env, MarkdownIt, Token } from 'markdown-it';
import { createMd, preprocess, CiteItem } from './markdown';
import { latexToOmml } from './math';
import { Citer, Cluster, Seg } from './cite';
import { sniffImage } from './images';
import { highlight } from './highlight';
import { postprocess } from './postprocess';

export interface VaultHost {
	readText(path: string): Promise<string | null>;
	readBinary(path: string): Promise<ArrayBuffer | null>;
	/** Resolves a link (wikilink target or relative markdown path) to a vault path. */
	resolve(link: string, fromPath: string): string | null;
	fetchRemote?(url: string): Promise<ArrayBuffer | null>;
	/** Converts images Word cannot show (SVG, WebP, AVIF) to PNG. Desktop/mobile: canvas. */
	rasterize?(data: ArrayBuffer, mime: string): Promise<{ data: ArrayBuffer; width: number; height: number } | null>;
	/** Draws a Mermaid diagram with the app's own Mermaid, as PNG. Null if it can't. */
	renderMermaid?(code: string): Promise<{ data: ArrayBuffer; width: number; height: number } | null>;
	/** Runs a Dataview (DQL) query with the Dataview plugin and returns its result as Markdown. */
	dataviewMarkdown?(query: string, fromPath: string): Promise<{ ok: true; markdown: string } | { ok: false; error: string } | null>;
}

export interface ExportOptions {
	page: 'A4' | 'Letter';
	breaks: boolean;
	title: 'auto' | 'always' | 'never';
	pageNumbers: boolean;
	wikilinks: 'text' | 'keep-brackets';
	bibliography?: { items: Map<string, import('./bibtex').CslItem>; styleXml: string; localeXml: string; title: string };
	/** Pro: styles.xml (and theme) taken from the user's reference .docx/.dotx */
	template?: ArrayBuffer;
}

export interface ExportResult { data: Uint8Array; warnings: string[] }

const CALLOUT_COLORS: Record<string, string> = {
	note: '086DDD', info: '086DDD', todo: '086DDD', abstract: '00A6A3', summary: '00A6A3', tldr: '00A6A3', tip: '00A6A3', hint: '00A6A3', important: '00A6A3',
	success: '08A045', check: '08A045', done: '08A045', question: 'D97706', help: 'D97706', faq: 'D97706', warning: 'D97706', caution: 'D97706', attention: 'D97706',
	failure: 'E93147', fail: 'E93147', missing: 'E93147', danger: 'E93147', error: 'E93147', bug: 'E93147', example: '7852EE', quote: '808080', cite: '808080',
};
function tint(hex: string, f = 0.9): string {
	const n = parseInt(hex, 16);
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * f));
	return c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

interface TNode { t: Token; kids: TNode[] }
/** Token.meta set by our Markdown rules and markdown-it-footnote. */
interface TokenMeta { id?: number; items?: CiteItem[]; narrative?: boolean; [k: string]: unknown }
/** IRunOptions-typed literal (TextRun also accepts a string, which confuses the deprecation lint about String#italics). */
const runOpts = (o: IRunOptions): IRunOptions => o;
/** Paragraphs that finish() replaces with the bibliography. */
const BIB_MARKERS = new WeakSet<object>();
function toTree(tokens: Token[]): TNode[] {
	const root: TNode = { t: null as unknown as Token, kids: [] };
	const stack = [root];
	for (const t of tokens) {
		if (t.nesting === -1) { stack.pop(); continue; }
		const n: TNode = { t, kids: [] };
		stack[stack.length - 1].kids.push(n);
		if (t.nesting === 1) stack.push(n);
	}
	return root.kids;
}

interface Box { color: string; fill: string }
interface Ctx { path: string; level: number; box?: Box; quote: number; depth: number; seen: Set<string>; parse: Parsed; inTable?: boolean }
interface Parsed { tree: TNode[]; env: Env; footnotes: Map<number, TNode[]> }
type Block = Paragraph | Table;
type Fmt = { color?: string; bold?: boolean; italics?: boolean; strike?: boolean; highlight?: boolean; code?: boolean; sup?: boolean; sub?: boolean; underline?: boolean };

export class Converter {
	private md: MarkdownIt;
	private warnings: string[] = [];
	private footnotes: Record<number, { children: Paragraph[] }> = {};
	private fnId = 0;
	private listInstance = 0;
	private startRefs = new Map<number, string>();
	readonly math: string[] = [];
	readonly clusters: Cluster[] = [];
	private citer: Citer | null = null;
	private bibIndex = -1;
	private contentWidthPx: number;
	private pendingBreak = false;

	constructor(private host: VaultHost, private opts: ExportOptions) {
		const keys = new Set(opts.bibliography ? [...opts.bibliography.items.keys()] : []);
		this.md = createMd({ breaks: opts.breaks, citeKeys: keys });
		if (opts.bibliography) {
			try { this.citer = new Citer(opts.bibliography.items, opts.bibliography.styleXml, opts.bibliography.localeXml); }
			catch (e) { this.warn(`Citation style could not be loaded: ${(e as Error).message}`); }
		}
		this.contentWidthPx = opts.page === 'A4' ? 602 : 624;
	}
	private warn(s: string) { if (!this.warnings.includes(s)) this.warnings.push(s); }

	private parse(src: string): Parsed {
		const env: Env = {};
		const tokens = this.md.parse(src, env);
		const tree = toTree(tokens);
		const footnotes = new Map<number, TNode[]>();
		const walk = (nodes: TNode[]) => {
			for (const n of nodes) {
				if (n.t.type === 'footnote_open') footnotes.set((n.t.meta as { id: number }).id, n.kids);
				else if (n.kids.length) walk(n.kids);
			}
		};
		walk(tree.filter((n) => n.t.type === 'footnote_block_open'));
		return { tree: tree.filter((n) => n.t.type !== 'footnote_block_open'), env, footnotes };
	}

	async convert(markdown: string, notePath: string, noteTitle: string): Promise<ExportResult> {
		const { body } = preprocess(markdown);
		const parsed = this.parse(body);
		const ctx: Ctx = { path: notePath, level: -1, quote: 0, depth: 0, seen: new Set([notePath]), parse: parsed };
		const blocks: Block[] = [];
		const first = parsed.tree[0];
		const hasH1 = first && first.t.type === 'heading_open' && first.t.tag === 'h1';
		if (this.opts.title === 'always' || (this.opts.title === 'auto' && !hasH1)) blocks.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(noteTitle)] }));
		blocks.push(...(await this.blocks(parsed.tree, ctx)));
		return this.finish([blocks]);
	}

	/** Pro: several notes in one document, each starting on a new page. */
	async convertMany(notes: { markdown: string; path: string; title: string }[]): Promise<ExportResult> {
		const parts: Block[][] = [];
		for (const [i, n] of notes.entries()) {
			const parsed = this.parse(preprocess(n.markdown).body);
			const ctx: Ctx = { path: n.path, level: -1, quote: 0, depth: 0, seen: new Set([n.path]), parse: parsed };
			const first = parsed.tree[0];
			const blocks: Block[] = [];
			if (!(first && first.t.type === 'heading_open' && first.t.tag === 'h1')) blocks.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: i > 0, children: [new TextRun(n.title)] }));
			else this.pendingBreak = i > 0;
			blocks.push(...(await this.blocks(parsed.tree, ctx)));
			parts.push(blocks);
		}
		return this.finish(parts);
	}

	private async finish(parts: Block[][]): Promise<ExportResult> {
		const children = parts.flat();
		let citeSegs = new Map<string, Seg[]>();
		if (this.citer && this.clusters.length) {
			citeSegs = this.citer.format(this.clusters);
			for (const k of this.citer.missing) this.warn(`Citation key not found in bibliography: @${k}`);
			const bib = this.citer.bibliography();
			if (bib && bib.entries.length) {
				const bibBlocks: Block[] = [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(this.opts.bibliography!.title)] })];
				for (const e of bib.entries) bibBlocks.push(new Paragraph({ style: 'Bibliography', indent: bib.hanging ? { left: 720, hanging: 720 } : undefined, spacing: { after: 160 }, children: segRuns(e) }));
				const at = children.findIndex((c) => BIB_MARKERS.has(c));
				if (at >= 0) children.splice(at, 1, ...bibBlocks); else children.push(...bibBlocks);
			}
		} else if (this.clusters.length) this.warn('This note has citations, but no bibliography file is set. Choose one in Settings → Docxwise → Bibliography file.');

		const s = this.opts.page === 'A4' ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 };
		const numberingConfig = [
			{ reference: 'ul', levels: Array.from({ length: 9 }, (_, l) => ({ level: l, format: LevelFormat.BULLET, text: ['•', '◦', '▪'][l % 3], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 + 360 * l, hanging: 360 } }, run: { font: l % 3 === 1 ? 'Courier New' : undefined } } })) },
			...[1, ...this.startRefs.keys()].map((start) => ({ reference: start === 1 ? 'ol' : this.startRefs.get(start)!, levels: Array.from({ length: 9 }, (_, l) => ({ level: l, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][l % 3], text: `%${l + 1}.`, start: l === 0 ? start : 1, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 + 360 * l, hanging: 360 } } } })) })),
		];
		const font = 'Calibri';
		const doc = new Document({
			creator: '', title: '', features: { updateFields: false },
			numbering: { config: numberingConfig },
			footnotes: this.footnotes,
			styles: {
				default: {
					document: { run: { font, size: 22 }, paragraph: { spacing: { after: 140, line: 276 } } },
					title: { run: { font, size: 48, bold: true, color: '111827' }, paragraph: { spacing: { after: 240 } } },
					heading1: { run: { font, size: 34, bold: true, color: '111827' }, paragraph: { spacing: { before: 360, after: 140 }, keepNext: true } },
					heading2: { run: { font, size: 28, bold: true, color: '111827' }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true } },
					heading3: { run: { font, size: 24, bold: true, color: '1F2937' }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true } },
					heading4: { run: { font, size: 22, bold: true, italics: true, color: '1F2937' }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true } },
					heading5: { run: { font, size: 22, bold: true, color: '374151' }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true } },
					heading6: { run: { font, size: 22, italics: true, color: '374151' }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true } },
					hyperlink: { run: { color: '1D4ED8', underline: {} } },
					footnoteText: { run: { size: 18 }, paragraph: { spacing: { after: 40, line: 240 } } },
				},
				paragraphStyles: [
					{ id: 'SourceCode', name: 'Source Code', basedOn: 'Normal', run: { font: 'Consolas', size: 19 }, paragraph: { spacing: { before: 120, after: 160, line: 252 }, shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 4 }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 4 }, left: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 4 }, right: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 4 } } } },
					{ id: 'BlockText', name: 'Block Text', basedOn: 'Normal', run: { color: '4B5563' }, paragraph: { indent: { left: 240 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'D1D5DB', space: 10 } } } },
					{ id: 'Callout', name: 'Callout', basedOn: 'Normal', paragraph: { spacing: { after: 80 } } },
					{ id: 'CalloutTitle', name: 'Callout Title', basedOn: 'Normal', next: 'Callout', run: { bold: true }, paragraph: { spacing: { after: 60 }, keepNext: true } },
					{ id: 'Bibliography', name: 'Bibliography', basedOn: 'Normal' },
					{ id: 'Caption', name: 'Caption', basedOn: 'Normal', run: { size: 18, italics: true, color: '4B5563' } },
					{ id: 'TableText', name: 'Table Text', basedOn: 'Normal', paragraph: { spacing: { before: 40, after: 40, line: 252 } } },
				],
				characterStyles: [
					{ id: 'VerbatimChar', name: 'Verbatim Char', run: { font: 'Consolas', size: 20, shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } } },
				],
			},
			sections: [{
				properties: { page: { size: s, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
				footers: this.opts.pageNumbers ? { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '6B7280' })] })] }) } : undefined,
				children,
			}],
		});
		const buf = await Packer.toArrayBuffer(doc);
		const data = await postprocess(buf, { math: this.math, cites: citeSegs, template: this.opts.template, warn: (w) => this.warn(w) });
		return { data, warnings: this.warnings };
	}

	// ---------- blocks ----------
	private pOpts(ctx: Ctx, o: IParagraphOptions): IParagraphOptions {
		if (ctx.quote > 0 && !o.style && !o.numbering) return { ...o, style: 'BlockText' };
		return o;
	}

	private async blocks(nodes: TNode[], ctx: Ctx): Promise<Block[]> {
		const out: Block[] = [];
		const isCode = (n: TNode) => (n.t.type === 'fence' || n.t.type === 'code_block') && (n.t.info || '').trim().split(/\s+/)[0] !== 'math';
		for (let i = 0; i < nodes.length; i++) {
			// Word and LibreOffice merge the border/shading of adjacent paragraphs with identical
			// settings, so two code blocks in a row would look like one. A 1pt spacer keeps them apart.
			if (i > 0 && isCode(nodes[i]) && isCode(nodes[i - 1])) out.push(new Paragraph({ spacing: { before: 0, after: 0, line: 120, lineRule: 'exact' as never }, children: [] }));
			out.push(...(await this.block(nodes[i], ctx)));
		}
		return out;
	}

	private async block(n: TNode, ctx: Ctx): Promise<Block[]> {
		const t = n.t;
		switch (t.type) {
			case 'paragraph_open': {
				const inline = n.kids[0]?.t;
				if (!inline) return [];
				const kids = (inline.children ?? []).filter((c) => !(c.type === 'text' && !c.content.trim()) && c.type !== 'softbreak');
				if (kids.length === 1 && kids[0].type === 'embed') {
					const r = await this.embedBlock(kids[0], ctx);
					if (r) return r;
				}
				if (kids.length === 1 && (kids[0].type === 'math_inline_display')) return [this.displayMath(kids[0].content, ctx)];
				const splitAt = kids.findIndex((k) => {
					if (k.type !== 'embed') return false;
					const file = (k.meta as { target: string }).target.split('#')[0].trim();
					return !/\.(png|jpe?g|gif|bmp|svg|webp|avif|pdf|mp3|mp4|webm|wav|m4a|ogg|mov)$/i.test(file) && !!this.host.resolve(file || ctx.path, ctx.path);
				});
				if (splitAt >= 0) {
					// a note embed inside running text: Obsidian shows it as a block, so split the paragraph around it
					const all = inline.children ?? [];
					const idx = all.indexOf(kids[splitAt]);
					const out: Block[] = [];
					const before = all.slice(0, idx), after = all.slice(idx + 1);
					if (before.some((k) => k.content.trim() || k.type !== 'text')) out.push(new Paragraph(this.pOpts(ctx, { keepNext: true, style: ctx.box ? 'Callout' : undefined, children: await this.inline(before, ctx) })));
					out.push(...((await this.embedBlock(all[idx], ctx)) ?? [new Paragraph({ children: await this.inline([all[idx]], ctx) })]));
					if (after.some((k) => k.content.trim() || (k.type !== 'text' && k.type !== 'softbreak'))) out.push(new Paragraph(this.pOpts(ctx, { style: ctx.box ? 'Callout' : undefined, children: await this.inline(after, ctx) })));
					return out;
				}
				return [new Paragraph(this.pOpts(ctx, { style: ctx.box ? 'Callout' : undefined, children: await this.inline(inline.children ?? [], ctx) }))];
			}
			case 'heading_open': {
				const lv = parseInt(t.tag.slice(1), 10);
				const H = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][lv - 1];
				const pb = this.pendingBreak; this.pendingBreak = false;
				return [new Paragraph({ heading: H, pageBreakBefore: pb || undefined, children: await this.inline(n.kids[0]?.t.children ?? [], ctx) })];
			}
			case 'bullet_list_open': case 'ordered_list_open': return this.list(n, ctx);
			case 'blockquote_open': return this.quote(n, ctx);
			case 'fence': case 'code_block': {
				const lang = (t.info || '').trim().split(/\s+/)[0];
				if (lang === 'math') return [this.displayMath(t.content, ctx)];
				if (lang === 'mermaid') {
					const r = this.host.renderMermaid ? await this.host.renderMermaid(t.content) : null;
					if (r) {
						let w = r.width, h = r.height;
						const max = this.contentWidthPx - (ctx.box ? 40 : 0);
						if (w > max) { h = Math.round(h * max / w); w = max; }
						if (h > 820) { w = Math.round(w * 820 / h); h = 820; }
						return [new Paragraph(this.pOpts(ctx, { alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: r.data, transformation: { width: w, height: h }, altText: { name: 'Mermaid diagram', description: 'Mermaid diagram', title: 'Mermaid diagram' } })] }))];
					}
					this.warn(this.host.renderMermaid ? 'A Mermaid diagram could not be drawn (check its syntax); it was kept as code.' : 'Mermaid diagrams are drawn only inside Obsidian; kept as code.');
				}
				if (lang === 'dataview') {
					const r = this.host.dataviewMarkdown ? await this.host.dataviewMarkdown(t.content, ctx.path) : null;
					if (r && r.ok) {
						if (!r.markdown.trim()) return [new Paragraph(this.pOpts(ctx, { children: [new TextRun(runOpts({ text: 'No results.', italics: true, color: '6B7280' }))] }))];
						const parsed = this.parse(r.markdown);
						return this.blocks(parsed.tree, { ...ctx, parse: parsed });
					}
					this.warn(r ? `A Dataview query failed and was kept as code: ${r.error.split('\n')[0].slice(0, 120)}` : 'Dataview queries need the Dataview plugin enabled; kept as code.');
				}
				if (lang === 'dataviewjs') this.warn('DataviewJS blocks can\'t be exported; kept as code. Use a regular Dataview query (```dataview) to export its results.');
				const code = t.content.replace(/\n$/, '').replace(/\t/g, '    ');
				const segs = highlight(code, lang) ?? [{ text: code }];
				const runs: TextRun[] = [];
				for (const sg of segs) sg.text.split('\n').forEach((part, i) => {
					if (i > 0) runs.push(new TextRun({ break: 1 }));
					if (part) runs.push(new TextRun(runOpts({ text: part, color: sg.color, italics: sg.italic || undefined })));
				});
				const o = this.pOpts(ctx, { style: 'SourceCode', children: runs });
				return [new Paragraph(ctx.box ? { ...o, style: 'SourceCode' } : o)];
			}
			case 'math_block': return [this.displayMath(t.content, ctx)];
			case 'hr': return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } }, spacing: { after: 240 }, children: [] })];
			case 'table_open': return [await this.table(n, ctx), new Paragraph({ spacing: { after: 0, line: 200, lineRule: 'exact' as never }, children: [] })];
			case 'html_block': {
				if (/<!--\s*(bibliography|refs)\s*-->|<div id="refs">/i.test(t.content)) { this.bibIndex = -2; return [this.bibMarker()]; }
				const txt = t.content.replace(/<[^>]+>/g, '').trim();
				return txt ? [new Paragraph(this.pOpts(ctx, { children: [new TextRun(txt)] }))] : [];
			}
			default:
				return n.kids.length ? this.blocks(n.kids, ctx) : [];
		}
	}

	private bibMarker(): Paragraph {
		// Placeholder object; finish() replaces it with the bibliography.
		const p = new Paragraph({ children: [] });
		BIB_MARKERS.add(p);
		return p;
	}

	private displayMath(tex: string, ctx: Ctx): Paragraph {
		const r = latexToOmml(tex, true);
		if (!r.ok) { this.warn(`Equation could not be converted, kept as text: ${tex.slice(0, 40)}`); return new Paragraph(this.pOpts(ctx, { children: [new TextRun({ text: tex, font: 'Consolas' })] })); }
		this.math.push(r.omml);
		return new Paragraph(this.pOpts(ctx, { alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [new TextRun(`@@M${this.math.length - 1}@@`)] }));
	}

	private async list(n: TNode, ctx: Ctx): Promise<Block[]> {
		const ordered = n.t.type === 'ordered_list_open';
		const start = ordered ? parseInt(String(n.t.attrGet('start') ?? '1'), 10) || 1 : 1;
		let ref = ordered ? 'ol' : 'ul';
		if (ordered && start !== 1) { if (!this.startRefs.has(start)) this.startRefs.set(start, `ol-${start}`); ref = this.startRefs.get(start)!; }
		const instance = ++this.listInstance;
		const level = Math.min(ctx.level + 1, 8);
		const out: Block[] = [];
		for (const item of n.kids) {
			if (item.t.type !== 'list_item_open') continue;
			let firstPara = true;
			for (const c of item.kids) {
				if (c.t.type === 'paragraph_open' && firstPara) {
					firstPara = false;
					const inl = c.kids[0]?.t;
					const children = inl?.children ?? [];
					const task = !ordered && children[0]?.type === 'text' ? /^\[([ xX/-])\]\s/.exec(children[0].content) : null;
					if (task) {
						const rest = [Object.assign(Object.create(Object.getPrototypeOf(children[0]) as object) as Token, children[0], { content: children[0].content.slice(task[0].length) }), ...children.slice(1)];
						const done = task[1] !== ' ';
						const runs = await this.inline(rest, ctx, done ? { strike: false } : {});
						out.push(new Paragraph(this.pOpts(ctx, { indent: { left: 720 + 360 * level, hanging: 360 }, spacing: { after: 60 }, children: [new TextRun({ text: done ? '☒\t' : '☐\t', font: 'Segoe UI Symbol' }), ...runs] })));
					} else {
						out.push(new Paragraph(this.pOpts(ctx, { numbering: { reference: ref, level, instance }, spacing: { after: 60 }, children: await this.inline(children, ctx) })));
					}
				} else if (c.t.type === 'paragraph_open') {
					out.push(new Paragraph(this.pOpts(ctx, { indent: { left: 720 + 360 * level }, spacing: { after: 60 }, children: await this.inline(c.kids[0]?.t.children ?? [], ctx) })));
				} else {
					out.push(...(await this.block(c, { ...ctx, level })));
				}
			}
		}
		if (ctx.level < 0 && !ctx.box && out.length) {
			const last = out[out.length - 1];
			if (last instanceof Paragraph) out.push(new Paragraph({ spacing: { after: 0, line: 120 }, children: [] }));
		}
		return out;
	}

	private async quote(n: TNode, ctx: Ctx): Promise<Block[]> {
		const first = n.kids[0];
		const inl = first?.t.type === 'paragraph_open' ? first.kids[0]?.t : null;
		const m = inl ? /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(inl.content) : null;
		if (!m || !inl) return this.blocks(n.kids, { ...ctx, quote: ctx.quote + 1 });
		const type = m[1].toLowerCase();
		const color = CALLOUT_COLORS[type] ?? '086DDD';
		const box: Box = { color, fill: tint(color, 0.9) };
		const c2: Ctx = { ...ctx, box, quote: 0, level: -1 };
		const titleText = m[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
		const titleTokens = this.md.parseInline(titleText, ctx.parse.env)[0]?.children ?? [];
		const inner: Block[] = [new Paragraph({ style: 'CalloutTitle', keepNext: true, children: await this.inline(titleTokens, c2, { bold: true, color: box.color }) })];
		const restSrc = inl.content.slice(m[0].length).replace(/^\n/, '');
		if (restSrc.trim()) inner.push(new Paragraph({ style: 'Callout', children: await this.inline(this.md.parseInline(restSrc, ctx.parse.env)[0]?.children ?? [], c2) }));
		inner.push(...(await this.blocks(n.kids.slice(1), c2)));
		const last = inner[inner.length - 1];
		if (!(last instanceof Paragraph)) inner.push(new Paragraph({ spacing: { after: 0 }, children: [] }));
		const total = (this.opts.page === 'A4' ? 9026 : 9360) - (ctx.box ? 400 : 0);
		const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
		const cell = new TableCell({
			width: { size: total, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: box.fill, color: 'auto' },
			margins: { top: 100, bottom: 60, left: 200, right: 200 },
			borders: { left: { style: BorderStyle.SINGLE, size: 24, color: box.color }, top: none, bottom: none, right: none },
			children: inner,
		});
		return [
			new Table({ rows: [new TableRow({ children: [cell] })], width: { size: total, type: WidthType.DXA }, columnWidths: [total], layout: TableLayoutType.FIXED, borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none } }),
			new Paragraph({ spacing: { after: 0, line: 160, lineRule: 'exact' as never }, children: [] }),
		];
	}

	private async table(n: TNode, ctx: Ctx): Promise<Table> {
		const rows: { cells: { tokens: Token[]; align: string | null }[]; header: boolean }[] = [];
		const walk = (nodes: TNode[], header: boolean) => {
			for (const x of nodes) {
				if (x.t.type === 'thead_open') walk(x.kids, true);
				else if (x.t.type === 'tbody_open') walk(x.kids, false);
				else if (x.t.type === 'tr_open') rows.push({ header, cells: x.kids.map((c) => ({ tokens: c.kids[0]?.t.children ?? [], align: /text-align:(\w+)/.exec(String(c.t.attrGet('style') ?? ''))?.[1] ?? null })) });
			}
		};
		walk(n.kids, false);
		const cols = Math.max(...rows.map((r) => r.cells.length));
		const w: number[] = new Array<number>(cols).fill(4);
		for (const r of rows) r.cells.forEach((c, i) => { const len = c.tokens.reduce((a, t) => a + (t.content?.length ?? 0), 0); w[i] = Math.max(w[i], Math.min(len, 40)); });
		const total = (this.opts.page === 'A4' ? 9026 : 9360) - (ctx.box ? 400 : 0);
		const sum = w.reduce((a, b) => a + b, 0);
		const widths = w.map((x) => Math.round((x / sum) * total));
		const border = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };
		const trows: TableRow[] = [];
		for (const r of rows) {
			const cells: TableCell[] = [];
			for (let i = 0; i < cols; i++) {
				const c = r.cells[i];
				const align = c?.align === 'center' ? AlignmentType.CENTER : c?.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
				const runs = c ? await this.inline(c.tokens, { ...ctx, box: undefined, inTable: true }, r.header ? { bold: true } : {}) : [];
				cells.push(new TableCell({ width: { size: widths[i], type: WidthType.DXA }, shading: r.header ? { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ style: 'TableText', alignment: align, children: runs })] }));
			}
			trows.push(new TableRow({ tableHeader: r.header, cantSplit: true, children: cells }));
		}
		return new Table({ rows: trows, width: { size: total, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border } });
	}

	// ---------- embeds and images ----------
	private splitTarget(target: string): { file: string; sub: string | null; size: string | null } {
		const [file, ...rest] = target.split('#');
		return { file: file.trim(), sub: rest.length ? rest.join('#').trim() : null, size: null };
	}

	private async embedBlock(tok: Token, ctx: Ctx): Promise<Block[] | null> {
		const { target, alias } = tok.meta as { target: string; alias?: string };
		const { file, sub } = this.splitTarget(target);
		if (/\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i.test(file)) {
			const img = await this.image(file, ctx, alias);
			return img ? [new Paragraph(this.pOpts(ctx, { children: [img] }))] : null;
		}
		if (/\.(pdf|mp3|mp4|webm|wav|m4a|ogg|mov|canvas|base)$/i.test(file)) return null;
		const path = this.host.resolve(file || ctx.path, ctx.path);
		if (!path) { this.warn(`Embedded note not found: ${file}`); return null; }
		if (ctx.seen.has(path + '#' + (sub ?? '')) || ctx.depth >= 5) { this.warn(`Skipped a repeated embed: ${file}`); return null; }
		const text = await this.host.readText(path);
		if (text == null) return null;
		const src = preprocess(sub ? extractSection(text, sub) : text).body;
		const parsed = this.parse(src);
		const seen = new Set(ctx.seen); seen.add(path + '#' + (sub ?? ''));
		return this.blocks(parsed.tree, { ...ctx, path, depth: ctx.depth + 1, seen, parse: parsed });
	}

	private async image(src: string, ctx: Ctx, sizeSpec?: string, alt?: string): Promise<ParagraphChild | null> {
		let data: ArrayBuffer | null = null;
		if (/^https?:\/\//i.test(src)) data = this.host.fetchRemote ? await this.host.fetchRemote(src) : null;
		else {
			const p = this.host.resolve(decodeURI(src), ctx.path);
			data = p ? await this.host.readBinary(p) : null;
		}
		if (!data) { this.warn(`Image not found: ${src}`); return new TextRun(runOpts({ text: `[${alt || src}]`, italics: true, color: '6B7280' })); }
		let info = sniffImage(data);
		if (!info && this.host.rasterize) {
			const mime = /\.svg$/i.test(src) ? 'image/svg+xml' : /\.webp$/i.test(src) ? 'image/webp' : 'image/*';
			const r = await this.host.rasterize(data, mime);
			if (r) { data = r.data; info = { type: 'png', width: r.width, height: r.height }; }
		}
		if (!info) { this.warn(`Image format not supported in Word: ${src}`); return new TextRun(runOpts({ text: `[${alt || src}]`, italics: true, color: '6B7280' })); }
		let w = info.width, h = info.height;
		const sm = sizeSpec ? /^(\d+)(?:x(\d+))?$/.exec(sizeSpec.trim()) : null;
		if (sm) { const nw = +sm[1]; h = sm[2] ? +sm[2] : Math.round(h * nw / w); w = nw; }
		const max = this.contentWidthPx - (ctx.box ? 40 : 0) - (ctx.inTable ? 300 : 0);
		if (w > max) { h = Math.round(h * max / w); w = max; }
		if (h > 820) { w = Math.round(w * 820 / h); h = 820; }
		return new ImageRun({ type: info.type, data, transformation: { width: w, height: h }, altText: alt ? { name: alt, description: alt, title: alt } : undefined });
	}

	// ---------- inline ----------
	private async inline(tokens: Token[], ctx: Ctx, base: Fmt = {}): Promise<ParagraphChild[]> {
		const out: ParagraphChild[] = [];
		const fmt: Fmt = { ...base };
		let link: { href: string; runs: ParagraphChild[] } | null = null;
		const push = (r: ParagraphChild) => { if (link) link.runs.push(r); else out.push(r); };
		const text = (s: string, extra: Record<string, unknown> = {}) => new TextRun(runOpts({
			text: s, bold: fmt.bold, italics: fmt.italics, strike: fmt.strike, highlight: fmt.highlight ? 'yellow' : undefined,
			style: fmt.code ? 'VerbatimChar' : link ? 'Hyperlink' : undefined, superScript: fmt.sup, subScript: fmt.sub, color: link ? undefined : fmt.color, underline: fmt.underline ? {} : undefined, ...extra,
		}));
		for (const t of tokens) {
			const meta = (t.meta ?? {}) as TokenMeta;
			switch (t.type) {
				case 'text': {
					let c = t.content;
					const nx = tokens[tokens.indexOf(t) + 1];
					if (this.citer?.isNote && nx?.type === 'citation' && !(nx.meta)?.narrative) c = c.replace(/\s+$/, '');
					if (c) push(text(c));
					break;
				}
				case 'strong_open': fmt.bold = true; break; case 'strong_close': fmt.bold = base.bold; break;
				case 'em_open': fmt.italics = true; break; case 'em_close': fmt.italics = base.italics; break;
				case 's_open': fmt.strike = true; break; case 's_close': fmt.strike = false; break;
				case 'mark_open': fmt.highlight = true; break; case 'mark_close': fmt.highlight = false; break;
				case 'code_inline': fmt.code = true; push(text(t.content)); fmt.code = false; break;
				case 'softbreak': push(this.opts.breaks ? new TextRun({ break: 1 }) : text(' ')); break;
				case 'hardbreak': push(new TextRun({ break: 1 })); break;
				case 'link_open': {
					const href = String(t.attrGet('href') ?? '');
					if (/^(https?|mailto):/i.test(href)) link = { href, runs: [] };
					break;
				}
				case 'link_close': if (link) { out.push(new ExternalHyperlink({ link: link.href, children: link.runs })); link = null; } break;
				case 'image': {
					const alt = t.content || '';
					const am = /^(.*?)\|(\d+(?:x\d+)?)$/.exec(alt);
					const img = await this.image(String(t.attrGet('src') ?? ''), ctx, am?.[2], am ? am[1] : alt);
					if (img) push(img);
					break;
				}
				case 'math_inline': case 'math_inline_display': {
					const r = latexToOmml(t.content, false);
					if (!r.ok) { this.warn(`Equation could not be converted, kept as text: ${t.content.slice(0, 40)}`); push(text(t.content)); break; }
					this.math.push(r.omml); push(new TextRun(`@@M${this.math.length - 1}@@`));
					break;
				}
				case 'wikilink': {
					const { target, alias } = meta as { target: string; alias?: string };
					const label = alias ?? target.replace(/#\^?/, ' › ').replace(/^ › /, '');
					push(text(this.opts.wikilinks === 'keep-brackets' ? `[[${label}]]` : label));
					break;
				}
				case 'embed': {
					const { target, alias } = meta as { target: string; alias?: string };
					if (/\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i.test(target)) { const img = await this.image(target.split('#')[0], ctx, alias); if (img) push(img); }
					else {
						if (!this.host.resolve(target.split('#')[0] || ctx.path, ctx.path)) this.warn(`Embedded note not found: ${target}`);
						push(text(alias ?? target));
					}
					break;
				}
				case 'footnote_ref': {
					const id = meta.id as number;
					const content = ctx.parse.footnotes.get(id);
					const fid = ++this.fnId;
					this.footnotes[fid] = { children: [] };
					const paras = content ? await this.blocks(content.filter((k) => k.t.type !== 'footnote_anchor'), { ...ctx, box: undefined, quote: 0, level: -1 }) : [];
					this.footnotes[fid].children = paras.filter((p): p is Paragraph => p instanceof Paragraph);
					if (!this.footnotes[fid].children.length) this.footnotes[fid].children = [new Paragraph({ children: [] })];
					push(new FootnoteReferenceRun(fid));
					break;
				}
				case 'footnote_anchor': break;
				case 'citation': {
					const items = meta.items as CiteItem[];
					const cid = `c${this.clusters.length}`;
					if (this.citer?.isNote) {
						const fid = ++this.fnId;
						this.footnotes[fid] = { children: [new Paragraph({ children: [new TextRun(`@@C${cid}@@`)] })] };
						this.clusters.push({ id: cid, items, narrative: false, noteIndex: fid });
						if (meta.narrative) push(text(this.citer.authorName(items[0].key)));
						push(new FootnoteReferenceRun(fid));
					} else {
						this.clusters.push({ id: cid, items, narrative: !!meta.narrative, noteIndex: 0 });
						push(new TextRun(`@@C${cid}@@`));
					}
					break;
				}
				case 'html_inline': {
					const tag = /^<(\/?)(\w+)/.exec(t.content);
					if (!tag) break;
					const on = !tag[1];
					const name = tag[2].toLowerCase();
					if (name === 'br') push(new TextRun({ break: 1 }));
					else if (name === 'sup') fmt.sup = on; else if (name === 'sub') fmt.sub = on;
					else if (name === 'u' || name === 'ins') fmt.underline = on; else if (name === 'mark') fmt.highlight = on;
					else if (name === 'b' || name === 'strong') fmt.bold = on; else if (name === 'i' || name === 'em') fmt.italics = on;
					else if (name === 's' || name === 'del') fmt.strike = on;
					break;
				}
				default:
					if (t.children) out.push(...(await this.inline(t.children, ctx, fmt)));
					else if (t.content) push(text(t.content));
			}
		}
		return out;
	}
}

export function segRuns(segs: Seg[]): TextRun[] {
	return segs.map((s) => new TextRun(runOpts({ text: s.text, italics: s.i, bold: s.b, smallCaps: s.sc, superScript: s.sup, subScript: s.sub })));
}

export function extractSection(src: string, sub: string): string {
	const lines = src.split('\n');
	if (sub.startsWith('^')) {
		const id = sub.slice(1);
		const i = lines.findIndex((l) => new RegExp(`(^|\\s)\\^${id.replace(/[-]/g, '\\-')}\\s*$`).test(l));
		if (i < 0) return '';
		if (/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) return lines[i].replace(/^\s*/, '');
		let a = i, b = i;
		while (a > 0 && lines[a - 1].trim() && !/^\s*\^/.test(lines[a - 1])) a--;
		if (/^\^/.test(lines[i].trim())) { b = i - 1; a = b; while (a > 0 && lines[a - 1].trim()) a--; }
		return lines.slice(a, b + 1).join('\n');
	}
	const want = sub.split('#').pop()!.trim().toLowerCase();
	let start = -1, level = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
		if (!m) continue;
		if (start < 0 && m[2].trim().toLowerCase() === want) { start = i; level = m[1].length; continue; }
		if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
	}
	return start >= 0 ? lines.slice(start).join('\n') : '';
}
