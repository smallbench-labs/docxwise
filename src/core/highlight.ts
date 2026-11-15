// Syntax colors for code blocks: highlight.js core (BSD-3-Clause) with a fixed set of common languages, GitHub-light palette.
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import r from 'highlight.js/lib/languages/r';
import latex from 'highlight.js/lib/languages/latex';
import { decodeEntities } from './xml';

const LANGS: Record<string, unknown> = { javascript, typescript, python, bash, json, css, xml, sql, java, c, cpp, csharp, go, rust, yaml, markdown, r, latex };
for (const [k, v] of Object.entries(LANGS)) hljs.registerLanguage(k, v as never);

const COLORS: Record<string, string> = {
	keyword: 'CF222E', 'built_in': '8250DF', type: '8250DF', literal: '0550AE', number: '0550AE', string: '0A3069', regexp: '0A3069',
	comment: '6E7781', meta: '6E7781', title: '8250DF', 'title.function': '8250DF', 'title.class': '953800', attr: '0550AE', attribute: '0550AE',
	variable: '953800', 'template-variable': '953800', params: '24292F', tag: '116329', name: '116329', 'selector-tag': '116329',
	'selector-class': '0550AE', property: '0550AE', symbol: '0550AE', section: '0550AE', bullet: '953800', addition: '116329', deletion: '82071E',
};

export interface CodeSeg { text: string; color?: string; italic?: boolean }

/** Splits code into colored segments. Unknown or missing language: plain text (no auto-detection, to stay predictable). */
export function highlight(code: string, lang: string): CodeSeg[] | null {
	const l = lang.toLowerCase();
	if (!l || !hljs.getLanguage(l)) return null;
	const html = hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
	const out: CodeSeg[] = [];
	const stack: string[] = [];
	const re = /<span class="hljs-([^"]+)">|<\/span>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[1]) stack.push(m[1].split(' ')[0].replace(/_$/, ''));
		else if (m[0] === '</span>') stack.pop();
		else if (m[2]) {
			const cls = [...stack].reverse().find((s) => COLORS[s]);
			out.push({ text: decodeEntities(m[2]), color: cls ? COLORS[cls] : undefined, italic: cls === 'comment' });
		}
	}
	return out;
}
