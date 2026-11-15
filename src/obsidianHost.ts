import { App, TFile, loadMermaid, normalizePath, requestUrl } from 'obsidian';

/** The part of Obsidian's bundled Mermaid that Docxwise calls (v9 returns a string, v10+ an object). */
interface MermaidApi { render(id: string, text: string): Promise<string | { svg?: string }> }
import type { VaultHost } from './core/convert';

export class ObsidianHost implements VaultHost {
	constructor(private app: App) {}

	private file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}
	async readText(path: string) { const f = this.file(path); return f ? this.app.vault.cachedRead(f) : null; }
	async readBinary(path: string) { const f = this.file(path); return f ? this.app.vault.readBinary(f) : null; }

	resolve(link: string, fromPath: string): string | null {
		if (link.startsWith('./') || link.startsWith('../') || (link.includes('/') && !this.app.metadataCache.getFirstLinkpathDest(link, fromPath))) {
			const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
			const parts: string[] = [];
			for (const seg of `${dir}/${link}`.split('/')) {
				if (!seg || seg === '.') continue;
				if (seg === '..') parts.pop(); else parts.push(seg);
			}
			const p = normalizePath(parts.join('/'));
			if (this.file(p)) return p;
		}
		return this.app.metadataCache.getFirstLinkpathDest(link, fromPath)?.path ?? null;
	}

	async fetchRemote(url: string): Promise<ArrayBuffer | null> {
		try { const r = await requestUrl({ url, throw: false }); return r.status < 400 ? r.arrayBuffer : null; } catch { return null; }
	}


	private mermaidSeq = 0;

	/**
	 * Mermaid through Obsidian's own bundled Mermaid (desktop and mobile), so no extra library ships.
	 * An init directive per diagram forces the light theme (documents are printed on white) and SVG <text>
	 * labels instead of HTML labels (<foreignObject> would be blank or taint the canvas). Global Mermaid
	 * settings used by Obsidian's own preview are not touched.
	 */
	async renderMermaid(code: string) {
		let id = '';
		try {
			const mermaid = (await loadMermaid()) as MermaidApi;
			id = `docxwise-mermaid-${Date.now()}-${++this.mermaidSeq}`;
			const init = '%%{init: {"theme": "default", "htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%\n';
			const out = await mermaid.render(id, init + code);
			const svgText = typeof out === 'string' ? out : out?.svg;
			if (!svgText) return null;
			const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
			const svg = doc.documentElement;
			if (svg.nodeName !== 'svg') return null;
			const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
			if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
				svg.setAttribute('width', String(Math.ceil(vb[2])));
				svg.setAttribute('height', String(Math.ceil(vb[3])));
				svg.removeAttribute('style'); // drops max-width
			}
			const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
			return await this.rasterize(bytes.buffer, 'image/svg+xml', '#ffffff');
		} catch {
			// Syntax errors are expected; the caller keeps the diagram as code and lists it in the export notice.
			return null;
		} finally {
			// Mermaid leaves its scratch element behind when a diagram has a syntax error.
			if (id) { activeDocument.getElementById(id)?.remove(); activeDocument.getElementById('d' + id)?.remove(); }
		}
	}

	/** Dataview's public API: queryMarkdown runs a DQL query and returns Markdown (tables, lists, tasks). */
	async dataviewMarkdown(query: string, fromPath: string) {
		const dv = (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: { queryMarkdown?: (q: string, origin?: string) => Promise<{ successful: boolean; value?: string; error?: string }> } }> } })
			.plugins?.plugins?.['dataview']?.api;
		if (!dv?.queryMarkdown) return null;
		try {
			const r = await dv.queryMarkdown(query, fromPath);
			return r.successful ? { ok: true as const, markdown: r.value ?? '' } : { ok: false as const, error: String(r.error ?? 'unknown error') };
		} catch (e) {
			return { ok: false as const, error: (e as Error).message || String(e) };
		}
	}

	/** SVG / WebP / AVIF -> PNG through a canvas (works on desktop and mobile, no Node APIs). */
	async rasterize(data: ArrayBuffer, mime: string, background?: string) {
		const url = URL.createObjectURL(new Blob([data], { type: mime }));
		try {
			const img = new Image();
			await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('decode')); img.src = url; });
			const w = img.naturalWidth || 800, h = img.naturalHeight || 600;
			const scale = 2;
			const canvas = activeDocument.createElement('canvas');
			canvas.width = w * scale; canvas.height = h * scale;
			const g = canvas.getContext('2d');
			if (!g) return null;
			if (background) { g.fillStyle = background; g.fillRect(0, 0, canvas.width, canvas.height); }
			g.drawImage(img, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
			return blob ? { data: await blob.arrayBuffer(), width: w, height: h } : null;
		} catch { return null; } finally { URL.revokeObjectURL(url); }
	}
}
