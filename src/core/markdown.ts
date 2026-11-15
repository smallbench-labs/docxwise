// markdown-it configured for Obsidian syntax: $math$, $$math$$, [[wikilinks]], ![[embeds]], ==highlight==, [@citations], %%comments%%, ^block-ids.
import markdownit from 'markdown-it';
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';
import footnote from 'markdown-it-footnote';

export interface CiteItem { key: string; prefix?: string; suffix?: string; locator?: string; label?: string; suppressAuthor?: boolean }

const LABELS: [RegExp, string][] = [
	[/^(pp?\.|pages?)\s*/i, 'page'], [/^(chap\.|ch\.|chapters?)\s*/i, 'chapter'], [/^(sec\.|§§?|sections?)\s*/i, 'section'],
	[/^(fig\.|figures?)\s*/i, 'figure'], [/^(vol\.|volumes?)\s*/i, 'volume'], [/^(para\.|¶)\s*/i, 'paragraph'], [/^(l\.|ll\.|lines?)\s*/i, 'line'], [/^(n\.|nn\.|notes?)\s*/i, 'note'],
];

export function parseCiteGroup(inner: string): CiteItem[] | null {
	const parts = inner.split(';');
	const items: CiteItem[] = [];
	for (const raw of parts) {
		const m = /^(.*?)(-?)@([\w:.#$%&\-+?<>~/]*[\w])(.*)$/s.exec(raw.trim());
		if (!m) return null;
		const it: CiteItem = { key: m[3] };
		if (m[1].trim()) it.prefix = m[1].trim();
		if (m[2]) it.suppressAuthor = true;
		let rest = m[4].replace(/^\s*,\s*/, '').trim();
		if (rest) {
			let label = 'page', matched = false;
			for (const [re, l] of LABELS) { const lm = re.exec(rest); if (lm) { label = l; rest = rest.slice(lm[0].length); matched = true; break; } }
			const lm = /^([\divxlcdmIVXLCDM][\w–\-,\s]*?)(?=(,\s|$))/.exec(rest);
			if (lm && (matched || /^\d/.test(rest))) {
				it.locator = lm[1].trim(); it.label = label;
				const suf = rest.slice(lm[0].length).replace(/^,\s*/, '').trim();
				if (suf) it.suffix = suf;
			} else it.suffix = (matched ? m[4].replace(/^\s*,\s*/, '') : rest).trim();
		}
		items.push(it);
	}
	return items;
}

export function createMd(opts: { breaks: boolean; citeKeys: Set<string> }): MarkdownIt {
	const md = markdownit({ html: true, linkify: true, breaks: opts.breaks, typographer: false });
	md.use(footnote);

	// $$ display math block
	md.block.ruler.before('fence', 'math_block', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
		const pos = state.bMarks[startLine] + state.tShift[startLine];
		const max = state.eMarks[startLine];
		if (state.src.slice(pos, pos + 2) !== '$$') return false;
		const firstLine = state.src.slice(pos + 2, max);
		let content = '';
		let next = startLine;
		if (firstLine.trim().endsWith('$$') && firstLine.trim().length > 2) {
			content = firstLine.trim().slice(0, -2);
		} else {
			const lines: string[] = [firstLine];
			let found = false;
			for (next = startLine + 1; next < endLine; next++) {
				const s = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
				if (s.trim().endsWith('$$')) { lines.push(s.trim().slice(0, -2)); found = true; break; }
				lines.push(s);
			}
			if (!found) return false;
			content = lines.join('\n');
		}
		if (silent) return true;
		const t = state.push('math_block', 'math', 0);
		t.content = content.trim();
		t.block = true;
		t.map = [startLine, next + 1];
		state.line = next + 1;
		return true;
	}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

	// inline $math$ (Obsidian rules: no space after opening / before closing $)
	md.inline.ruler.after('escape', 'math_inline', (state: StateInline, silent: boolean) => {
		const s = state.src, p = state.pos;
		if (s[p] !== '$') return false;
		if (s[p + 1] === '$') {
			const end = s.indexOf('$$', p + 2);
			if (end < 0) return false;
			if (!silent) { const t = state.push('math_inline_display', 'math', 0); t.content = s.slice(p + 2, end).trim(); }
			state.pos = end + 2;
			return true;
		}
		if (/\s/.test(s[p + 1] ?? ' ')) return false;
		let end = p + 1;
		while ((end = s.indexOf('$', end)) !== -1) {
			if (s[end - 1] === '\\') { end++; continue; }
			if (/\s/.test(s[end - 1])) { end++; continue; }
			break;
		}
		if (end < 0 || end === p + 1) return false;
		if (/\d/.test(s[end + 1] ?? '')) return false;
		if (!silent) { const t = state.push('math_inline', 'math', 0); t.content = s.slice(p + 1, end); }
		state.pos = end + 1;
		return true;
	});

	// ![[embed]] and [[wikilink]]
	md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
		const s = state.src, p = state.pos;
		const embed = s[p] === '!' && s.startsWith('[[', p + 1);
		if (!embed && !s.startsWith('[[', p)) return false;
		const start = p + (embed ? 3 : 2);
		const end = s.indexOf(']]', start);
		if (end < 0) return false;
		const inner = s.slice(start, end);
		if (inner.includes('\n')) return false;
		if (!silent) {
			const t = state.push(embed ? 'embed' : 'wikilink', '', 0);
			const bar = inner.indexOf('|');
			t.meta = { target: (bar >= 0 ? inner.slice(0, bar) : inner).trim(), alias: bar >= 0 ? inner.slice(bar + 1).trim() : undefined };
			t.content = inner;
		}
		state.pos = end + 2;
		return true;
	});

	// [@cite; @cite2, p. 3]
	md.inline.ruler.before('link', 'citation', (state: StateInline, silent: boolean) => {
		const s = state.src, p = state.pos;
		if (s[p] !== '[' || !/^\[[^\]]*-?@/.test(s.slice(p, p + 200))) return false;
		const end = s.indexOf(']', p);
		if (end < 0 || s[end + 1] === '(' ) return false;
		const items = parseCiteGroup(s.slice(p + 1, end));
		if (!items) return false;
		if (!silent) { const t = state.push('citation', '', 0); t.meta = { items, narrative: false }; }
		state.pos = end + 1;
		return true;
	});
	// narrative @key (only for keys present in the bibliography, so emails and @mentions stay text)
	md.inline.ruler.after('citation', 'citation_narrative', (state: StateInline, silent: boolean) => {
		const s = state.src, p = state.pos;
		if (s[p] !== '@' || (p > 0 && /[\w.@]/.test(s[p - 1]))) return false;
		const m = /^@([\w:.#$%&\-+?<>~/]*\w)/.exec(s.slice(p));
		if (!m || !opts.citeKeys.has(m[1])) return false;
		let len = m[0].length;
		let locator: CiteItem | null = null;
		const lm = /^\s\[([^\]@]*)\]/.exec(s.slice(p + len));
		if (lm) { locator = parseCiteGroup(`@x, ${lm[1]}`)?.[0] ?? null; len += lm[0].length; }
		if (!silent) {
			const t = state.push('citation', '', 0);
			t.meta = { items: [{ key: m[1], locator: locator?.locator, label: locator?.label, suffix: locator?.suffix }], narrative: true };
		}
		state.pos = p + len;
		return true;
	});

	// ==highlight==
	md.inline.ruler.before('emphasis', 'mark', (state: StateInline, silent: boolean) => {
		const s = state.src, p = state.pos;
		if (!s.startsWith('==', p) || s[p + 2] === '=' || /\s/.test(s[p + 2] ?? ' ')) return false;
		const end = s.indexOf('==', p + 2);
		if (end < 0) return false;
		if (silent) return true;
		state.push('mark_open', 'mark', 1);
		const oldMax = state.posMax;
		state.pos = p + 2; state.posMax = end;
		state.md.inline.tokenize(state);
		state.posMax = oldMax;
		state.push('mark_close', 'mark', -1);
		state.pos = end + 2;
		return true;
	});
	return md;
}

/** Text-level clean-up before parsing: frontmatter, %%comments%%, trailing ^block-ids. Code fences are left untouched. */
export function preprocess(src: string): { body: string; frontmatter: string | null } {
	let frontmatter: string | null = null;
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(src);
	if (fm) { frontmatter = fm[1]; src = src.slice(fm[0].length); }
	const parts = src.split(/(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/m);
	for (let i = 0; i < parts.length; i += 2) {
		parts[i] = parts[i].replace(/%%[\s\S]*?%%/g, '').replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, '').replace(/^\^[A-Za-z0-9-]+[ \t]*$/gm, '');
	}
	return { body: parts.join(''), frontmatter };
}
