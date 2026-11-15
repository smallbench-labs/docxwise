import { AbstractInputSuggest, App, FuzzySuggestModal, Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import { Converter, ExportOptions } from './core/convert';
import { parseBibtex, CslItem } from './core/bibtex';
import { ObsidianHost } from './obsidianHost';
import { STYLES, LOCALE_EN_US } from './styles';
import { LicenseManager, DEFAULT_LICENSE_CONFIG } from './license/licenseManager';
import { EMPTY_LICENSE, LicenseCache, HttpPost } from './license/types';
import { KeyStore, selectKeyStore } from './license/keyStore';
import { requestUrl } from 'obsidian';
import { BuyGate } from './license/buyGate';
import { CHECKOUT_READY, CHECKOUT_URL } from './license/checkout';
import { ConsentState, openCheckoutIfConsented } from './license/consent';
import { buildConsentBlock } from './license/consentUi';
import { obsidianHttpGetJson } from './license/obsidianHttp';
import { appLocalStore, buildDeviceLabel, getDeviceCode } from './license/deviceLabel';

interface Settings {
	outputFolder: string; // '' = next to the note
	page: 'A4' | 'Letter';
	title: 'auto' | 'always' | 'never';
	pageNumbers: boolean;
	bibFile: string;
	style: string; // key of STYLES or 'custom'
	customCsl: string;
	refTitle: string; // '' = style default
	openAfter: boolean;
	templateFile: string; // Pro
	license: LicenseCache;
}
const DEFAULTS: Settings = { outputFolder: '', page: 'A4', title: 'auto', pageNumbers: true, bibFile: '', style: 'apa', customCsl: '', refTitle: '', openAfter: true, templateFile: '', license: { ...EMPTY_LICENSE } };

const httpPost: HttpPost = async (url, body) => {
	const res = await requestUrl({ url, method: 'POST', contentType: 'application/json', body: JSON.stringify(body), throw: false });
	let json: unknown = null;
	try { json = res.json; } catch { json = null; }
	return { status: res.status, json };
};

export default class DocxwisePlugin extends Plugin {
	settings!: Settings;
	license!: LicenseManager;
	keyStore!: KeyStore;
	private host!: ObsidianHost;
	deviceCode = '';
	deviceLabel = '';

	async onload() {
		await this.loadSettings();
		this.host = new ObsidianHost(this.app);
		this.deviceCode = getDeviceCode(appLocalStore(this.app));
		this.deviceLabel = buildDeviceLabel(Platform, this.deviceCode);
		this.license = new LicenseManager(this.settings.license, DEFAULT_LICENSE_CONFIG, httpPost, () => Date.now(), async (cache) => {
			this.keyStore.save(cache.key);
			this.settings.license = cache;
			await this.saveSettings();
		}, () => performance.now(), (ms) => new Promise((r) => window.setTimeout(r, ms)));
		this.license.setDeviceLabel(this.deviceLabel);

		this.addCommand({
			id: 'export-current-note',
			name: 'Export current note to .docx',
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== 'md') return false;
				if (!checking) void this.exportNotes([f], f);
				return true;
			},
		});
		this.addCommand({
			id: 'export-folder-merged',
			name: 'Export a folder as one .docx (Pro)',
			callback: () => new FolderPicker(this.app, (folder) => void this.exportFolder(folder)).open(),
		});
		this.addCommand({
			id: 'export-linked-merged',
			name: 'Export current note and the notes it links to as one .docx (Pro)',
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== 'md') return false;
				if (!checking) void this.exportLinked(f);
				return true;
			},
		});
		this.addRibbonIcon('file-output', 'Export current note to .docx', () => {
			const f = this.app.workspace.getActiveFile();
			if (!f || f.extension !== 'md') { new Notice('Open a note first, then export it to .docx.'); return; }
			void this.exportNotes([f], f);
		});
		this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
			if (file instanceof TFile && file.extension === 'md') menu.addItem((i) => i.setTitle('Export to .docx').setIcon('file-output').onClick(() => void this.exportNotes([file], file)));
			if (file instanceof TFolder) menu.addItem((i) => i.setTitle(this.isPro() ? 'Export folder as one .docx' : 'Export folder as one .docx (Pro)').setIcon('files').onClick(() => void this.exportFolder(file)));
		}));
		this.addSettingTab(new DocxwiseSettingTab(this.app, this));
		if (this.settings.license.key) this.app.workspace.onLayoutReady(() => { void this.license.onLoad(); });
	}

	isPro(): boolean { return this.license.isPro(); }

	private requirePro(feature: string): boolean {
		if (this.isPro()) return true;
		new Notice(`${feature} is part of Docxwise Pro. Add a license key in Settings → Docxwise.`, 6000);
		return false;
	}

	async exportFolder(folder: TFolder) {
		if (!this.requirePro('Merging notes')) return;
		const files: TFile[] = [];
		const walk = (f: TFolder) => { for (const c of f.children) { if (c instanceof TFile && c.extension === 'md') files.push(c); else if (c instanceof TFolder) walk(c); } };
		walk(folder);
		files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
		if (!files.length) { new Notice('This folder has no notes.'); return; }
		await this.exportNotes(files, null, folder.name || this.app.vault.getName(), folder.path);
	}

	async exportLinked(file: TFile) {
		if (!this.requirePro('Merging notes')) return;
		const links = this.app.metadataCache.getFileCache(file)?.links ?? [];
		const files: TFile[] = [];
		for (const l of links) {
			const t = this.app.metadataCache.getFirstLinkpathDest(l.link.split('#')[0], file.path);
			if (t && t.extension === 'md' && !files.includes(t) && t !== file) files.push(t);
		}
		if (!files.length) { new Notice('This note has no links to other notes.'); return; }
		await this.exportNotes(files, null, file.basename, file.parent?.path ?? '');
	}

	private async loadBibliography(file: TFile | null): Promise<ExportOptions['bibliography']> {
		const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		const bibPath = (typeof fm?.bibliography === 'string' && fm.bibliography) || this.settings.bibFile;
		if (!bibPath) return undefined;
		const resolved = this.host.resolve(bibPath, file?.path ?? '') ?? normalizePath(bibPath);
		const text = await this.host.readText(resolved);
		if (text == null) { new Notice(`Bibliography file not found: ${bibPath}`); return undefined; }
		let items: CslItem[] = [];
		try { items = /\.json$/i.test(resolved) ? (JSON.parse(text) as CslItem[]) : parseBibtex(text); }
		catch { new Notice(`Could not read ${bibPath}. Use a .bib or CSL JSON file.`); return undefined; }
		const cslFm = typeof fm?.csl === 'string' ? fm.csl : '';
		let styleXml = STYLES[this.settings.style]?.xml ?? STYLES.apa.xml;
		let refTitle = this.settings.refTitle || STYLES[this.settings.style]?.refTitle || 'References';
		const customPath = cslFm || (this.settings.style === 'custom' ? this.settings.customCsl : '');
		if (customPath) {
			if (STYLES[customPath]) { styleXml = STYLES[customPath].xml; refTitle = this.settings.refTitle || STYLES[customPath].refTitle; }
			else {
				const p = this.host.resolve(customPath, file?.path ?? '') ?? normalizePath(customPath);
				const x = await this.host.readText(p);
				if (x) styleXml = x; else new Notice(`Citation style not found: ${customPath}. Using ${STYLES[this.settings.style]?.label ?? 'APA'}.`);
			}
		}
		if (typeof fm?.['reference-section-title'] === 'string') refTitle = fm['reference-section-title'];
		return { items: new Map(items.filter((i) => i && i.id).map((i) => [String(i.id), i])), styleXml, localeXml: LOCALE_EN_US, title: refTitle };
	}

	private async exportNotes(files: TFile[], single: TFile | null, mergedName?: string, mergedFolder?: string) {
		const notice = new Notice('Exporting…', 0);
		try {
			let template: ArrayBuffer | undefined;
			if (this.settings.templateFile && this.isPro()) {
				const p = normalizePath(this.settings.templateFile);
				template = (await this.host.readBinary(p)) ?? undefined;
				if (!template) new Notice(`Template not found: ${this.settings.templateFile}`);
			}
			const strict = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.('strictLineBreaks') === true;
			const opts: ExportOptions = {
				page: this.settings.page, breaks: !strict, title: this.settings.title, pageNumbers: this.settings.pageNumbers, wikilinks: 'text',
				bibliography: await this.loadBibliography(single ?? files[0]), template,
			};
			const conv = new Converter(this.host, opts);
			const result = single
				? await conv.convert(await this.app.vault.cachedRead(single), single.path, titleFor(this.app, single))
				: await conv.convertMany(await Promise.all(files.map(async (f) => ({ markdown: await this.app.vault.cachedRead(f), path: f.path, title: titleFor(this.app, f) }))));
			const baseName = single ? single.basename : mergedName ?? 'Export';
			const folder = this.settings.outputFolder ? normalizePath(this.settings.outputFolder) : (single ? single.parent?.path ?? '' : mergedFolder ?? '');
			const outPath = normalizePath(`${folder && folder !== '/' ? folder + '/' : ''}${baseName}.docx`);
			if (folder && folder !== '/' && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			const existing = this.app.vault.getAbstractFileByPath(outPath);
			if (existing && !(existing instanceof TFile)) throw new UserError(`There is a folder named "${outPath}". Rename it or set another output folder in Settings → Docxwise.`);
			const bytes = result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength) as ArrayBuffer;
			try {
				if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes);
				else await this.app.vault.createBinary(outPath, bytes);
			} catch (e) {
				const code = (e as { code?: string }).code ?? '';
				if (/EBUSY|EPERM|EACCES/.test(code + (e as Error).message)) throw new UserError(`Couldn't save ${outPath}: the file is open in another app (for example Word) or is read-only. Close it and export again.`);
				throw e;
			}
			notice.hide();
			const app = this.app as unknown as { openWithDefaultApp?: (p: string) => void; showInFolder?: (p: string) => void };
			const autoOpen = this.settings.openAfter && Platform.isDesktopApp && !!app.openWithDefaultApp;
			const frag = createFragment((f) => {
				f.createDiv({ text: `${existing ? 'Updated' : 'Saved'} ${outPath}` });
				if (result.warnings.length) {
					f.createDiv({ cls: 'dw-notice-sub', text: `${result.warnings.length} thing${result.warnings.length > 1 ? 's' : ''} to check:` });
					const ul = f.createEl('ul', { cls: 'dw-notice-list' });
					for (const w of result.warnings.slice(0, 5)) ul.createEl('li', { text: w });
					if (result.warnings.length > 5) ul.createEl('li', { text: `…and ${result.warnings.length - 5} more` });
				}
				if (Platform.isDesktopApp) {
					const row = f.createDiv({ cls: 'dw-notice-actions' });
					if (!autoOpen && app.openWithDefaultApp) row.createEl('button', { text: 'Open' }).addEventListener('click', () => app.openWithDefaultApp?.call(this.app, outPath));
					if (app.showInFolder) row.createEl('button', { text: 'Show in folder' }).addEventListener('click', () => app.showInFolder?.call(this.app, outPath));
				} else {
					f.createDiv({ cls: 'dw-notice-sub', text: 'It is in your vault folder. Open it from the Files app or share it from there.' });
				}
			});
			new Notice(frag, result.warnings.length ? 15000 : 8000);
			if (autoOpen) app.openWithDefaultApp?.call(this.app, outPath);
		} catch (e) {
			notice.hide();
			if (e instanceof UserError) { new Notice(e.message, 10000); return; }
			console.error('Docxwise export failed', e);
			new Notice(`Export failed: ${(e as Error).message || String(e)}. If this keeps happening, please report it with a copy of the note.`, 10000);
		}
	}

	async loadSettings() {
		const raw = ((await this.loadData()) ?? {}) as Partial<Settings>;
		this.settings = { ...DEFAULTS, ...raw, license: { ...EMPTY_LICENSE, ...(raw.license ?? {}) } };
		this.keyStore = selectKeyStore(this.app);
		this.settings.license.key = this.keyStore.load(this.settings.license.key);
	}
	async saveSettings() {
		await this.saveData({ ...this.settings, license: { ...this.settings.license, key: this.keyStore.keyForDataJson(this.settings.license.key) } });
	}
}

/** An error whose message is written for the user (no stack, no prefix). */
class UserError extends Error {}

function titleFor(app: App, f: TFile): string {
	const t: unknown = app.metadataCache.getFileCache(f)?.frontmatter?.title;
	return typeof t === 'string' && t.trim() ? t.trim() : f.basename;
}

/** Vault path suggestions under a settings text field (folders, or files with given extensions). */
class PathSuggest extends AbstractInputSuggest<TAbstractFile> {
	constructor(app: App, private input: HTMLInputElement, private kind: 'folder' | RegExp, private onPick: (path: string) => void) { super(app, input); }
	getSuggestions(q: string): TAbstractFile[] {
		const query = q.toLowerCase();
		return this.app.vault.getAllLoadedFiles()
			.filter((f) => (this.kind === 'folder' ? f instanceof TFolder && f.path !== '/' : f instanceof TFile && (this.kind).test(f.name)))
			.filter((f) => f.path.toLowerCase().includes(query))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 50);
	}
	renderSuggestion(f: TAbstractFile, el: HTMLElement): void { el.setText(f.path); }
	selectSuggestion(f: TAbstractFile): void { this.input.value = f.path; this.onPick(f.path); this.close(); }
}

class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private pick: (f: TFolder) => void) { super(app); this.setPlaceholder('Pick a folder to export as one document'); }
	getItems(): TFolder[] { return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder); }
	getItemText(f: TFolder): string { return f.path || '/'; }
	onChooseItem(f: TFolder): void { this.pick(f); }
}

class DocxwiseSettingTab extends PluginSettingTab {
	private buyGate: BuyGate | null = null;
	private consent: ConsentState | null = null;
	private keyDraft = '';
	constructor(app: App, private plugin: DocxwisePlugin) { super(app, plugin); }

	hide(): void { this.buyGate = null; this.consent = null; }

	/** Same flow as Streakwise 0.2.1: status, Buy Pro (region-gated, consent first), device, key. */
	private proSection(el: HTMLElement): void {
		const s = this.plugin.settings;
		const lic = this.plugin.license;
		const pro = lic.isPro();
		new Setting(el).setName('Pro').setHeading();
		new Setting(el).setName('Word template').setDesc('Pro. A .docx or .dotx in your vault. Its fonts, heading styles, colors, header, footer and language are used for every export.')
			.addText((t) => {
				const set = async (v: string) => { s.templateFile = v.trim(); await this.plugin.saveSettings(); };
				t.setPlaceholder('Templates/report.dotx').setValue(s.templateFile).setDisabled(!pro).onChange(set);
				if (pro) new PathSuggest(this.app, t.inputEl, /\.(docx|dotx)$/i, (p) => void set(p));
			});
		const status = pro ? `Pro is active. Works offline for ${lic.graceDaysLeft()} more day${lic.graceDaysLeft() === 1 ? '' : 's'}.`
			: lic.state.status === 'invalid' ? 'Pro is locked: this key isn\'t active.' : 'You\'re on the free version.';
		new Setting(el).setName('Status').setDesc(lic.state.message ? `${status} ${lic.state.message}` : status);

		const gate = this.buyGate ?? (this.buyGate = new BuyGate(obsidianHttpGetJson));
		const buyRows = () => {
			if (pro) return;
			if (gate.current === 'unknown') { new Setting(el).setName('Checking region…'); return; }
			if (gate.failed()) { new Setting(el).setName('Docxwise Pro').setDesc('Couldn\'t check your region. Reopen settings later to try again.'); return; }
			if (!gate.visible()) return; // blocked region (Japan): no purchase option
			const st = new Setting(el).setName('Get Docxwise Pro')
				.setDesc('Your own Word templates and several notes merged into one document. US$19 once (plus tax), all future updates, 5 devices, 14-day refund; not available in Japan (see README).');
			const consent = this.consent = new ConsentState();
			buildConsentBlock(st.infoEl, consent, () => openCheckoutIfConsented(consent, CHECKOUT_URL, (u) => {
				if (!CHECKOUT_READY) { new Notice('Docxwise Pro is not on sale yet.'); return; }
				window.open(u);
			}), (u) => { window.open(u); });
		};
		void gate.ensure(() => this.display());
		const keyFirst = !!lic.state.key;
		if (!keyFirst) buyRows();
		new Setting(el).setName('This device').setDesc(`Device code ${this.plugin.deviceCode}. In the Polar customer portal this device is listed as "${this.plugin.deviceLabel}".`);
		this.keyDraft = lic.state.key;
		new Setting(el).setName('License key')
			.setDesc((this.plugin.keyStore.kind === 'keychain' ? 'Kept in Obsidian Keychain, not in your vault. '
				: 'Your Obsidian version has no Keychain, so the key is kept in plain text in this plugin\'s data.json. Update Obsidian to 1.11.4 or later to keep it in Keychain. ')
				+ 'Sent only to Polar (api.polar.sh), at most once a day.')
			.addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('License key').setValue(this.keyDraft).onChange((v) => { this.keyDraft = v.trim(); }); })
			.addButton((b) => b.setButtonText('Activate').setCta().onClick(async () => { b.setDisabled(true); await lic.activate(this.keyDraft, this.plugin.deviceLabel); this.display(); }))
			.addButton((b) => b.setButtonText('Remove').onClick(async () => { await lic.clear(); this.display(); }));
		if (keyFirst) buyRows();
	}
	display(): void {
		const { containerEl: el } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		el.empty();
		new Setting(el).setName('Output folder').setDesc('Leave empty to save each .docx next to its note. Exports always stay inside your vault; an existing .docx with the same name is replaced.')
			.addText((t) => {
				const set = async (v: string) => { s.outputFolder = v.trim(); await save(); };
				t.setPlaceholder('Exports').setValue(s.outputFolder).onChange(set);
				new PathSuggest(this.app, t.inputEl, 'folder', (p) => void set(p));
			});
		new Setting(el).setName('Page size').addDropdown((d) => d.addOptions({ A4: 'A4', Letter: 'US Letter' }).setValue(s.page).onChange(async (v) => { s.page = v as Settings['page']; await save(); }));
		new Setting(el).setName('Note name as title').setDesc('Automatic adds the note name as a title only when the note does not start with a top-level heading.')
			.addDropdown((d) => d.addOptions({ auto: 'Automatic', always: 'Always', never: 'Never' }).setValue(s.title).onChange(async (v) => { s.title = v as Settings['title']; await save(); }));
		new Setting(el).setName('Page numbers').setDesc('Centered in the footer. A Word template\'s own footer replaces it.').addToggle((t) => t.setValue(s.pageNumbers).onChange(async (v) => { s.pageNumbers = v; await save(); }));
		if (Platform.isDesktopApp) new Setting(el).setName('Open after export').setDesc('Open the .docx in your default app, for example Word, right after saving.').addToggle((t) => t.setValue(s.openAfter).onChange(async (v) => { s.openAfter = v; await save(); }));

		new Setting(el).setName('Citations').setHeading();
		new Setting(el).setName('Bibliography file').setDesc('A .bib or CSL JSON file in your vault, for example exported from Zotero. A note can override it with a "bibliography" property.')
			.addText((t) => {
				const set = async (v: string) => { s.bibFile = v.trim(); await save(); };
				t.setPlaceholder('References/library.bib').setValue(s.bibFile).onChange(set);
				new PathSuggest(this.app, t.inputEl, /\.(bib|json)$/i, (p) => void set(p));
			});
		new Setting(el).setName('Citation style').addDropdown((d) => {
			for (const [k, v] of Object.entries(STYLES)) d.addOption(k, v.label);
			d.addOption('custom', 'Other (.csl file)…');
			d.setValue(s.style).onChange(async (v) => { s.style = v; await save(); this.display(); });
		});
		if (s.style === 'custom') new Setting(el).setName('Style file').setDesc('Any CSL style from zotero.org/styles, saved in your vault.')
			.addText((t) => {
				const set = async (v: string) => { s.customCsl = v.trim(); await save(); };
				t.setPlaceholder('References/nature.csl').setValue(s.customCsl).onChange(set);
				new PathSuggest(this.app, t.inputEl, /\.csl$/i, (p) => void set(p));
			});
		new Setting(el).setName('Reference list heading').setDesc('Leave empty to use the style default.')
			.addText((t) => t.setPlaceholder(STYLES[s.style]?.refTitle ?? 'References').setValue(s.refTitle).onChange(async (v) => { s.refTitle = v; await save(); }));

		this.proSection(el);
	}
}
