// Minimal XML reader for well-formed MathML strings (temml output). No DOM needed, so it runs the same on desktop, mobile and in tests.
export interface XNode { tag: string; attrs: Record<string, string>; children: XNode[]; text?: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
		if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
		return ENT[e] ?? m;
	});
}
export function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function parseXml(src: string): XNode {
	const root: XNode = { tag: '#root', attrs: {}, children: [] };
	const stack: XNode[] = [root];
	const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const top = stack[stack.length - 1];
		if (m[5] !== undefined) {
			top.children.push({ tag: '#text', attrs: {}, children: [], text: decodeEntities(m[5]) });
		} else if (m[2]) {
			if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
			const attrs: Record<string, string> = {};
			const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
			let a: RegExpExecArray | null;
			while ((a = ar.exec(m[3] || ''))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
			const node: XNode = { tag: m[2].replace(/^.*:/, ''), attrs, children: [] };
			top.children.push(node);
			if (!m[4]) stack.push(node);
		}
	}
	return root;
}

export function textOf(n: XNode): string {
	if (n.tag === '#text') return n.text ?? '';
	return n.children.map(textOf).join('');
}
