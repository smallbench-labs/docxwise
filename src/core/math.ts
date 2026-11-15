// LaTeX -> MathML (temml, MIT) -> OMML (Office Math, native editable Word equations).
import temml from 'temml';
import { parseXml, XNode, esc, textOf } from './xml';

let INLINE = false;
const NARY = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰', '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨀', '⨄', '⨆']);
const ACCENTS = new Set(['ˆ', '^', '˜', '~', '¯', '‾', '→', '⃗', '˙', '¨', '´', '`', 'ˇ', '˘', '˚', '←', '↔', '^', '\u0302', '\u0303', '\u0304', '\u0307', '\u0308', '\u20d7']);

function elems(n: XNode): XNode[] { return n.children.filter((c) => c.tag !== '#text' || (c.text ?? '').trim() !== ''); }

function run(text: string, opts: { plain?: boolean; normal?: boolean; bold?: boolean } = {}): string {
	if (!text) return '';
	let rpr = '';
	if (opts.normal) rpr = '<m:rPr><m:nor/></m:rPr>';
	else if (opts.plain && opts.bold) rpr = '<m:rPr><m:sty m:val="b"/></m:rPr>';
	else if (opts.plain) rpr = '<m:rPr><m:sty m:val="p"/></m:rPr>';
	else if (opts.bold) rpr = '<m:rPr><m:sty m:val="bi"/></m:rPr>';
	const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
	return `<m:r>${rpr}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t${space}>${esc(text)}</m:t></m:r>`;
}

function e(inner: string, tag = 'm:e'): string { return `<${tag}>${inner}</${tag}>`; }

function isFence(n: XNode | undefined, form: string): boolean {
	return !!n && n.tag === 'mo' && n.attrs.fence === 'true' && (n.attrs.form === form || n.attrs.form === undefined);
}
function isNary(n: XNode | undefined): XNode | null {
	if (!n) return null;
	if (n.tag === 'mo' && NARY.has(textOf(n).trim())) return n;
	if ((n.tag === 'msubsup' || n.tag === 'munderover' || n.tag === 'msub' || n.tag === 'munder' || n.tag === 'msup' || n.tag === 'mover')) {
		const b = elems(n)[0];
		if (b && b.tag === 'mo' && NARY.has(textOf(b).trim())) return n;
	}
	if (n.tag === 'mrow' && elems(n).length === 1) return isNary(elems(n)[0]);
	return null;
}

function nary(n: XNode, body: string): string {
	if (n.tag === 'mrow') n = elems(n)[0];
	const k = elems(n);
	const op = n.tag === 'mo' ? textOf(n).trim() : textOf(k[0]).trim();
	let sub = '', sup = '';
	if (n.tag === 'msubsup' || n.tag === 'munderover') { sub = conv(k[1]); sup = conv(k[2]); }
	else if (n.tag === 'msub' || n.tag === 'munder') sub = conv(k[1]);
	else if (n.tag === 'msup' || n.tag === 'mover') sup = conv(k[1]);
	const isInt = /[∫∬∭∮∯∰]/.test(op);
	const limLoc = INLINE || isInt || n.tag === 'msubsup' || n.tag === 'msub' || n.tag === 'msup' ? 'subSup' : 'undOvr';
	const pr = `<m:naryPr><m:chr m:val="${esc(op)}"/><m:limLoc m:val="${limLoc}"/>${sub ? '' : '<m:subHide m:val="1"/>'}${sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`;
	return `<m:nary>${pr}${e(sub, 'm:sub')}${e(sup, 'm:sup')}${e(body)}</m:nary>`;
}

function seq(nodes: XNode[]): string {
	let out = '';
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		// \left( ... \right) and fenced groups -> m:d (auto-growing delimiters)
		if (isFence(n, 'prefix')) {
			let depth = 0, j = i + 1;
			for (; j < nodes.length; j++) {
				if (isFence(nodes[j], 'prefix') && nodes[j].attrs.form === 'prefix') depth++;
				else if (isFence(nodes[j], 'postfix')) { if (depth === 0) break; depth--; }
			}
			if (j < nodes.length && (n.attrs.stretchy !== 'false' || nodes[j].attrs.stretchy !== 'false')) {
				const beg = textOf(n).trim(), end = textOf(nodes[j]).trim();
				// split on \middle separators is rare; keep simple
				out += `<m:d><m:dPr><m:begChr m:val="${esc(beg)}"/><m:endChr m:val="${esc(end)}"/></m:dPr>${e(seq(nodes.slice(i + 1, j)))}</m:d>`;
				i = j;
				continue;
			}
		}
		const nn = isNary(n);
		if (nn) {
			// operand: next element (or next run of elements until a relation/plus at same level)
			const rest: XNode[] = [];
			let j = i + 1;
			for (; j < nodes.length; j++) {
				const t = nodes[j];
				if (t.tag === 'mo' && /^[=<>≤≥≠≈+\-−,;]$/.test(textOf(t).trim()) && rest.length) break;
				if (isNary(t) && rest.length) break;
				rest.push(t);
			}
			out += nary(nn, seq(rest));
			i = j - 1;
			continue;
		}
		out += conv(n);
	}
	return out;
}

function conv(n: XNode | undefined): string {
	if (!n) return '';
	const k = elems(n);
	switch (n.tag) {
		case '#text': return '';
		case '#root': case 'math': case 'mrow': case 'mstyle': case 'mpadded': case 'semantics': case 'mprescripts':
			return seq(k);
		case 'annotation': case 'annotation-xml': return '';
		case 'mi': {
			const t = textOf(n);
			const v = n.attrs.mathvariant;
			const plain = v === 'normal' || (t.length > 1 && v !== 'italic');
			return run(t, { plain, bold: v === 'bold' || v === 'bold-italic' });
		}
		case 'mn': return run(textOf(n), { plain: true });
		case 'mo': {
			const t = textOf(n);
			if (t === '\u2061' || t === '\u2062' || t === '\u2063') return '';
			return run(t, { plain: true });
		}
		case 'mtext': case 'ms': return run(textOf(n), { normal: true });
		case 'mspace': {
			const w = parseFloat(n.attrs.width || '0');
			if (w >= 0.9) return run('\u2003'.repeat(Math.min(4, Math.round(w))), { plain: true }); // \quad = 1em, \qqquad = 2em
			if (w >= 0.25) return run('\u2005', { plain: true });
			if (w > 0) return run('\u2009', { plain: true });
			return '';
		}
		case 'mfrac': {
			const noBar = n.attrs.linethickness !== undefined && parseFloat(n.attrs.linethickness) === 0;
			return `<m:f>${noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''}${e(conv(k[0]), 'm:num')}${e(conv(k[1]), 'm:den')}</m:f>`;
		}
		case 'msup': return `<m:sSup>${e(conv(k[0]))}${e(conv(k[1]), 'm:sup')}</m:sSup>`;
		case 'msub': return `<m:sSub>${e(conv(k[0]))}${e(conv(k[1]), 'm:sub')}</m:sSub>`;
		case 'msubsup': return `<m:sSubSup>${e(conv(k[0]))}${e(conv(k[1]), 'm:sub')}${e(conv(k[2]), 'm:sup')}</m:sSubSup>`;
		case 'msqrt': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${e(seq(k))}</m:rad>`;
		case 'mroot': return `<m:rad>${e(conv(k[1]), 'm:deg')}${e(conv(k[0]))}</m:rad>`;
		case 'mover': case 'munder': {
			const base = k[0], acc = k[1];
			const at = textOf(acc ?? n).trim();
			if (n.tag === 'mover' && acc && acc.tag === 'mo' && ACCENTS.has(at)) {
				const chr = at === 'ˆ' || at === '^' ? '\u0302' : at === '˜' || at === '~' ? '\u0303' : at === '¯' || at === '‾' ? '\u0305' : at === '→' ? '\u20d7' : at === '˙' ? '\u0307' : at === '¨' ? '\u0308' : at;
				if (at === '‾' || at === '¯') return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${e(conv(base))}</m:bar>`;
				return `<m:acc><m:accPr><m:chr m:val="${esc(chr)}"/></m:accPr>${e(conv(base))}</m:acc>`;
			}
			if (acc && acc.tag === 'mo' && (at === '⏟' || at === '⏞' || at === '︸' || at === '︷')) {
				return `<m:groupChr><m:groupChrPr><m:chr m:val="${esc(at)}"/><m:pos m:val="${n.tag === 'munder' ? 'bot' : 'top'}"/></m:groupChrPr>${e(conv(base))}</m:groupChr>`;
			}
			if (n.tag === 'munder' && acc && (at === '_' || at === '‾' || at === '̲')) return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr>${e(conv(base))}</m:bar>`;
			const tag = n.tag === 'mover' ? 'm:limUpp' : 'm:limLow';
			return `<${tag}>${e(conv(base))}${e(conv(acc), 'm:lim')}</${tag}>`;
		}
		case 'munderover': return `<m:limUpp>${e(`<m:limLow>${e(conv(k[0]))}${e(conv(k[1]), 'm:lim')}</m:limLow>`)}${e(conv(k[2]), 'm:lim')}</m:limUpp>`;
		case 'mtable': {
			const rows = k.filter((r) => r.tag === 'mtr' || r.tag === 'mlabeledtr');
			const cls = n.attrs.class || '';
			const isAlign = /tml-jot|tml-align|tml-gather/.test(cls) || n.attrs.displaystyle === 'true' && rows.every((r) => elems(r).length <= 2) && /tml-(right|left)/.test(JSON.stringify(rows.map((r) => elems(r).map((c) => c.attrs.class)) ));
			if (isAlign) {
				// Alignment points: m:aln on the first run after "&". This is what Word itself writes when saving
				// (MS-OI29500 22.1.2.3; see jgm/texmath#150). Spec also allows literal "&" in m:t, but LibreOffice shows it as ∧.
				return `<m:eqArr>${rows.map((r) => {
					const cells = elems(r).map((c) => seq(elems(c)));
					let row = cells[0] ?? '';
					if (cells.length > 1) {
						// Empty left side ("&= ..."): an invisible normal-text run. Word ignores it; LibreOffice otherwise shows ¿ instead of the relation.
						if (!row) row = '<m:r><m:rPr><m:nor/></m:rPr><m:t>\u200b</m:t></m:r>';
						let c2 = cells.slice(1).join('');
						if (c2.startsWith('<m:r><m:rPr>')) c2 = c2.replace('</m:rPr>', '<m:aln/></m:rPr>');
						else if (c2.startsWith('<m:r>')) c2 = '<m:r><m:rPr><m:aln/></m:rPr>' + c2.slice(5);
						row += c2;
					}
					return e(row);
				}).join('')}</m:eqArr>`;
			}
			const cols = Math.max(1, ...rows.map((r) => elems(r).length));
			const mpr = `<m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>`;
			return `<m:m>${mpr}${rows.map((r) => {
				const cells = elems(r);
				let s = '';
				for (let c = 0; c < cols; c++) s += e(cells[c] ? seq(elems(cells[c])) : '');
				return `<m:mr>${s}</m:mr>`;
			}).join('')}</m:m>`;
		}
		case 'mtd': case 'mtr': return seq(k);
		case 'menclose': {
			const no = n.attrs.notation || '';
			if (/top/.test(no) && !/box/.test(no)) return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${e(seq(k))}</m:bar>`;
			if (/bottom/.test(no) && !/box/.test(no)) return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr>${e(seq(k))}</m:bar>`;
			if (/box|roundedbox/.test(no)) return `<m:borderBox>${e(seq(k))}</m:borderBox>`;
			return seq(k);
		}
		case 'mphantom': return `<m:phant><m:phantPr><m:show m:val="0"/></m:phantPr>${e(seq(k))}</m:phant>`;
		case 'mmultiscripts': return seq(k);
		case 'merror': return run(textOf(n), { normal: true });
		default: return seq(k);
	}
}

export interface MathResult { omml: string; ok: boolean; error?: string }

export function latexToOmml(latex: string, display: boolean): MathResult {
	try {
		const mml = temml.renderToString(latex, { xml: true, displayMode: display, throwOnError: true, trust: false });
		INLINE = !display;
		const body = conv(parseXml(mml));
		const omml = `<m:oMath>${body}</m:oMath>`;
		return { omml: display ? `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${omml}</m:oMathPara>` : omml, ok: true };
	} catch (err) {
		return { omml: '', ok: false, error: String((err as Error)?.message ?? err) };
	}
}
