declare module 'markdown-it-footnote' {
	import type MarkdownIt from 'markdown-it';
	const footnote: (md: MarkdownIt) => void;
	export default footnote;
}
declare module 'citeproc' {
	/** The parts of the citeproc-js engine Docxwise uses. */
	export interface CslBibParams { hangingindent?: number | boolean; linespacing?: number; entryspacing?: number }
	export interface CslEngine {
		opt: { xclass: string };
		updateItems(ids: string[]): void;
		rebuildProcessorState(citations: object[], mode: string): [string, number, string][];
		makeBibliography(): [CslBibParams, string[]] | false;
	}
	const CSL: { Engine: new (sys: object, styleXml: string) => CslEngine };
	export default CSL;
}
declare module '*.csl' { const s: string; export default s; }
declare module '*.xml' { const s: string; export default s; }
