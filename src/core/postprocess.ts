// Second pass over the packed .docx: swaps placeholders for native equations (OMML) and formatted citations,
// and (Pro) merges the user's reference template styles.
import JSZip from 'jszip';
import type { Seg } from './cite';
import { esc } from './xml';

function segXml(segs: Seg[]): string {
	return segs.map((s) => {
		let pr = '';
		if (s.b) pr += '<w:b/>';
		if (s.i) pr += '<w:i/>';
		if (s.sc) pr += '<w:smallCaps/>';
		if (s.sup) pr += '<w:vertAlign w:val="superscript"/>';
		else if (s.sub) pr += '<w:vertAlign w:val="subscript"/>';
		return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(s.text)}</w:t></w:r>`;
	}).join('');
}

const RUN_WITH = (marker: string) => new RegExp(`<w:r>(?:(?!<w:r>|</w:r>).)*?${marker}(?:(?!</w:r>).)*?</w:r>`, 'gs');

export async function postprocess(buf: ArrayBuffer, o: { math: string[]; cites: Map<string, Seg[]>; template?: ArrayBuffer; warn: (s: string) => void }): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(buf);
	for (const part of ['word/document.xml', 'word/footnotes.xml']) {
		const f = zip.file(part);
		if (!f) continue;
		let x = await f.async('string');
		if (!/@@[MC]/.test(x)) continue;
		// display equations: the placeholder is the only run in its paragraph -> m:oMathPara
		x = x.replace(RUN_WITH('@@M(\\d+)@@'), (m: string, i: string) => o.math[+i] ?? '');
		x = x.replace(RUN_WITH('@@C(c\\d+)@@'), (m: string, id: string) => segXml(o.cites.get(id) ?? [{ text: '?' }]));
		zip.file(part, x);
	}
	if (o.template) {
		try { await applyTemplate(zip, o.template); } catch (e) { o.warn(`Template could not be applied: ${(e as Error).message}`); }
	}
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** Replaces our styles with the template's, keeping any of our styles the template does not define (e.g. Source Code).
 *  Also takes the template's theme, document language, page setup, and headers/footers (with their images). */
async function applyTemplate(zip: JSZip, tpl: ArrayBuffer): Promise<void> {
	const t = await JSZip.loadAsync(tpl);
	const tStyles = await t.file('word/styles.xml')?.async('string');
	if (!tStyles) throw new Error('no styles.xml in template');
	const ours = (await zip.file('word/styles.xml')!.async('string'));
	const ids = new Set([...tStyles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"/g)].map((m) => m[1]));
	const extra = [...ours.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[\s\S]*?<\/w:style>/g)].filter((m) => !ids.has(m[1])).map((m) => m[0]);
	zip.file('word/styles.xml', tStyles.replace(/<\/w:styles>\s*$/, extra.join('') + '</w:styles>'));
	const theme = await t.file('word/theme/theme1.xml')?.async('string');
	if (theme && zip.file('word/theme/theme1.xml')) zip.file('word/theme/theme1.xml', theme);

	// Document language (spell-check / hyphenation) lives in styles docDefaults (copied above) and settings themeFontLang.
	const tSettings = await t.file('word/settings.xml')?.async('string');
	const lang = tSettings ? /<w:themeFontLang\b[^>]*\/>/.exec(tSettings)?.[0] : undefined;
	const sf = zip.file('word/settings.xml');
	if (lang && sf) {
		let x = await sf.async('string');
		x = /<w:themeFontLang\b[^>]*\/>/.test(x) ? x.replace(/<w:themeFontLang\b[^>]*\/>/, lang) : x;
		zip.file('word/settings.xml', x);
	}

	// Headers, footers and page setup from the template's last section.
	const tDoc = await t.file('word/document.xml')?.async('string');
	const tRels = await t.file('word/_rels/document.xml.rels')?.async('string');
	if (!tDoc || !tRels) return;
	const tSect = /<w:sectPr\b[\s\S]*?<\/w:sectPr>(?![\s\S]*<w:sectPr\b)/.exec(tDoc)?.[0];
	if (!tSect) return;
	const refs = [...tSect.matchAll(/<w:(header|footer)Reference\b[^>]*\/>/g)].map((m) => m[0]);
	const docFile = zip.file('word/document.xml')!;
	let doc = await docFile.async('string');
	let rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
	let types = await zip.file('[Content_Types].xml')!.async('string');
	const newRefs: string[] = [];
	let n = 0;
	for (const ref of refs) {
		const rid = /r:id="([^"]+)"/.exec(ref)?.[1];
		const rel = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*/>`).exec(tRels)?.[0] : undefined;
		const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
		const kind = ref.startsWith('<w:header') ? 'header' : 'footer';
		if (!target) continue;
		const src = t.file(`word/${target.replace(/^\/?word\//, '')}`);
		if (!src) continue;
		n++;
		const name = `tpl${kind}${n}.xml`;
		let part = await src.async('string');
		// copy the part's own relationships (logos in headers) under new media names
		const partRels = await t.file(`word/_rels/${target.split('/').pop()}.rels`)?.async('string');
		if (partRels) {
			let outRels = partRels;
			for (const m of partRels.matchAll(/Target="(media\/[^"]+)"/g)) {
				const media = t.file(`word/${m[1]}`);
				if (!media) continue;
				const newName = `media/tpl${n}-${m[1].split('/').pop()}`;
				zip.file(`word/${newName}`, await media.async('uint8array'));
				outRels = outRels.replace(`Target="${m[1]}"`, `Target="${newName}"`);
				const ext = m[1].split('.').pop()!.toLowerCase();
				if (!new RegExp(`Extension="${ext}"`, 'i').test(types)) types = types.replace('</Types>', `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/></Types>`);
			}
			zip.file(`word/_rels/${name}.rels`, outRels);
		}
		zip.file(`word/${name}`, part);
		const newId = `rIdTpl${n}`;
		rels = rels.replace('</Relationships>', `<Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${name}"/></Relationships>`);
		types = types.replace('</Types>', `<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/></Types>`);
		newRefs.push(ref.replace(/r:id="[^"]+"/, `r:id="${newId}"`));
		void part;
	}
	const ourSect = /<w:sectPr\b[\s\S]*?<\/w:sectPr>(?![\s\S]*<w:sectPr\b)/.exec(doc)?.[0];
	if (ourSect) {
		let sect = ourSect;
		const types2 = new Set(newRefs.map((r) => (/<w:(header|footer)Reference/.exec(r)![1]) + (/w:type="(\w+)"/.exec(r)?.[1] ?? 'default')));
		// template headers/footers replace ours of the same kind+type (e.g. our page-number footer)
		sect = sect.replace(/<w:(header|footer)Reference\b[^>]*\/>/g, (m: string) => types2.has((/<w:(header|footer)Reference/.exec(m)![1]) + (/w:type="(\w+)"/.exec(m)?.[1] ?? 'default')) ? '' : m);
		sect = sect.replace(/(<w:sectPr\b[^>]*>)/, `$1${newRefs.join('')}`);
		for (const tag of ['pgSz', 'pgMar']) {
			const tv = new RegExp(`<w:${tag}\\b[^>]*/>`).exec(tSect)?.[0];
			if (tv) sect = sect.replace(new RegExp(`<w:${tag}\\b[^>]*/>`), tv);
		}
		if (/<w:titlePg\b/.test(tSect) && !/<w:titlePg\b/.test(sect)) sect = /<w:docGrid\b/.test(sect) ? sect.replace(/<w:docGrid\b/, '<w:titlePg/><w:docGrid') : sect.replace('</w:sectPr>', '<w:titlePg/></w:sectPr>');
		doc = doc.replace(ourSect, sect);
	}
	// header/footer order inside sectPr must stay first: they were inserted right after <w:sectPr>.
	zip.file('word/document.xml', doc);
	zip.file('word/_rels/document.xml.rels', rels);
	zip.file('[Content_Types].xml', types);
}
