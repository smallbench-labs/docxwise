// CSL styles bundled with the plugin (CC BY-SA 3.0, citation-style-language/styles). Imported as text by esbuild.
import apa from '../assets/apa.csl';
import chicagoAD from '../assets/chicago-author-date.csl';
import chicagoNotes from '../assets/chicago-notes-bibliography.csl';
import mla from '../assets/modern-language-association.csl';
import ieee from '../assets/ieee.csl';
import enUS from '../assets/locales-en-US.xml';

export const STYLES: Record<string, { label: string; xml: string; refTitle: string }> = {
	apa: { label: 'APA 7th', xml: apa, refTitle: 'References' },
	'chicago-author-date': { label: 'Chicago (author-date)', xml: chicagoAD, refTitle: 'References' },
	'chicago-notes': { label: 'Chicago (notes and bibliography)', xml: chicagoNotes, refTitle: 'Bibliography' },
	mla: { label: 'MLA 9th', xml: mla, refTitle: 'Works Cited' },
	ieee: { label: 'IEEE', xml: ieee, refTitle: 'References' },
};
export const LOCALE_EN_US = enUS;
