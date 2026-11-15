// Small BibTeX/BibLaTeX -> CSL-JSON converter covering the fields citation styles actually use.
export type CslItem = Record<string, unknown> & { id: string; type: string };

const TYPE: Record<string, string> = {
	article: 'article-journal', book: 'book', booklet: 'pamphlet', inbook: 'chapter', incollection: 'chapter',
	inproceedings: 'paper-conference', conference: 'paper-conference', manual: 'report', mastersthesis: 'thesis',
	phdthesis: 'thesis', thesis: 'thesis', techreport: 'report', report: 'report', unpublished: 'manuscript', misc: 'document',
	online: 'webpage', www: 'webpage', electronic: 'webpage', proceedings: 'book', collection: 'book', dataset: 'dataset', software: 'software',
};
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ACC: Record<string, Record<string, string>> = {
	"'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' },
	'`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È' },
	'"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', O: 'Ö', U: 'Ü' },
	'^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û' },
	'~': { a: 'ã', n: 'ñ', o: 'õ', N: 'Ñ' },
	c: { c: 'ç', C: 'Ç', s: 'ş' }, v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě', C: 'Č', S: 'Š', Z: 'Ž' },
};

export function latexToText(s: string): string {
	s = s.replace(/\\([`'"^~])\s*\{?\\?([A-Za-z])\}?/g, (m, a: string, ch: string) => ACC[a]?.[ch] ?? ch);
	s = s.replace(/\\([cv])\{([A-Za-z])\}/g, (m, a: string, ch: string) => ACC[a]?.[ch] ?? ch);
	s = s.replace(/\\(ss|o|O|ae|AE|l|L|aa|AA)\b\s?/g, (m, k: string) => ({ ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å' } as Record<string, string>)[k]);
	s = s.replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\$/g, '$').replace(/\\#/g, '#');
	s = s.replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, '\u00a0');
	s = s.replace(/\\(textit|emph|textbf|textsc|textrm|url|mkbibquote)\{([^{}]*)\}/g, '$2');
	return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function splitNames(v: string): Record<string, string | undefined>[] {
	const parts: string[] = [];
	let depth = 0, cur = '';
	const words = v.split(/(\s+and\s+|[{}])/);
	for (const w of words) {
		if (w === '{') depth++;
		if (w === '}') depth--;
		if (depth === 0 && /^\s+and\s+$/.test(w)) { parts.push(cur); cur = ''; } else cur += w;
	}
	if (cur.trim()) parts.push(cur);
	return parts.map((p) => {
		p = p.trim();
		if (/^\{.*\}$/.test(p)) return { literal: latexToText(p) };
		if (p.includes(',')) {
			const [family, given] = p.split(/,(.*)/s);
			return { family: latexToText(family), given: latexToText(given ?? '') };
		}
		const toks = p.split(/\s+/);
		if (toks.length === 1) return { family: latexToText(p) };
		return { family: latexToText(toks[toks.length - 1]), given: latexToText(toks.slice(0, -1).join(' ')) };
	});
}

export function parseBibtex(src: string): CslItem[] {
	const out: CslItem[] = [];
	let i = 0;
	while ((i = src.indexOf('@', i)) !== -1) {
		const m = /^@(\w+)\s*([{(])/.exec(src.slice(i));
		if (!m) { i++; continue; }
		const type = m[1].toLowerCase();
		let j = i + m[0].length, depth = 1;
		const start = j;
		for (; j < src.length && depth > 0; j++) {
			const c = src[j];
			if (c === '{' || c === '(') depth++;
			else if (c === '}' || c === ')') depth--;
		}
		const body = src.slice(start, j - 1);
		i = j;
		if (type === 'comment' || type === 'preamble' || type === 'string') continue;
		const comma = body.indexOf(',');
		if (comma < 0) continue;
		const key = body.slice(0, comma).trim();
		const fields: Record<string, string> = {};
		const rest = body.slice(comma + 1);
		let k = 0;
		while (k < rest.length) {
			const fm = /^\s*([\w-]+)\s*=\s*/.exec(rest.slice(k));
			if (!fm) break;
			k += fm[0].length;
			let val = '';
			const c = rest[k];
			if (c === '{') {
				let d = 0, s = k;
				for (; k < rest.length; k++) { if (rest[k] === '{') d++; else if (rest[k] === '}') { d--; if (d === 0) { k++; break; } } }
				val = rest.slice(s + 1, k - 1);
			} else if (c === '"') {
				let s = ++k, d = 0;
				for (; k < rest.length; k++) { if (rest[k] === '{') d++; else if (rest[k] === '}') d--; else if (rest[k] === '"' && d === 0) break; }
				val = rest.slice(s, k); k++;
			} else {
				const vm = /^[^,}]*/.exec(rest.slice(k))!; val = vm[0].trim(); k += vm[0].length;
			}
			fields[fm[1].toLowerCase()] = val;
			const cm = /^\s*,?/.exec(rest.slice(k)); k += cm ? cm[0].length : 0;
		}
		const item: CslItem = { id: key, type: TYPE[type] ?? 'document' };
		const t = (f: string) => (fields[f] !== undefined ? latexToText(fields[f]) : undefined);
		if (fields.author) item.author = splitNames(fields.author);
		if (fields.editor) item.editor = splitNames(fields.editor);
		if (fields.translator) item.translator = splitNames(fields.translator);
		const map: [string, string][] = [['title', 'title'], ['publisher', 'publisher'], ['address', 'publisher-place'], ['location', 'publisher-place'],
			['volume', 'volume'], ['number', 'issue'], ['pages', 'page'], ['doi', 'DOI'], ['url', 'URL'], ['isbn', 'ISBN'], ['issn', 'ISSN'],
			['edition', 'edition'], ['note', 'note'], ['abstract', 'abstract'], ['institution', 'publisher'], ['school', 'publisher'], ['organization', 'publisher'], ['series', 'collection-title'], ['language', 'language']];
		for (const [b, c] of map) { const v = t(b); if (v !== undefined && item[c] === undefined) item[c] = c === 'URL' || c === 'DOI' ? fields[b].replace(/[{}]/g, '') : v; }
		if (typeof item.page === 'string') item.page = item.page.replace(/\s*[–-]+\s*/g, '–');
		const container = t('journal') ?? t('journaltitle') ?? t('booktitle');
		if (container) item['container-title'] = container;
		if (type === 'phdthesis') item.genre = 'PhD thesis';
		if (type === 'mastersthesis') item.genre = "Master's thesis";
		const date = fields.date;
		if (date) {
			const dm = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(date.trim());
			if (dm) item.issued = { 'date-parts': [[+dm[1], ...(dm[2] ? [+dm[2]] : []), ...(dm[3] ? [+dm[3]] : [])]] };
		} else if (fields.year) {
			const y = parseInt(latexToText(fields.year), 10);
			const mo = fields.month ? (MONTHS[fields.month.toLowerCase().slice(0, 3)] ?? parseInt(fields.month, 10)) : undefined;
			if (!isNaN(y)) item.issued = { 'date-parts': [[y, ...(mo ? [mo] : [])]] };
		}
		if (fields.urldate) { const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(fields.urldate); if (dm) item.accessed = { 'date-parts': [[+dm[1], +dm[2], +dm[3]]] }; }
		out.push(item);
	}
	return out;
}
