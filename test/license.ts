// Licensing unit tests (no network): region gate, consent gate, benefit_id check.
import { checkRegion, CHECKOUT_READY, CHECKOUT_URL } from '../src/license/checkout';
import { BuyGate } from '../src/license/buyGate';
import { ConsentState, openCheckoutIfConsented } from '../src/license/consent';
import { LicenseManager, DEFAULT_LICENSE_CONFIG } from '../src/license/licenseManager';
import { EMPTY_LICENSE, HttpPost } from '../src/license/types';

let fails = 0;
const ok = (c: boolean, name: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}`); if (!c) fails++; };
const never = () => new Promise<void>(() => {});
const now = () => Promise.resolve();

(async () => {
	ok(await checkRegion(async () => ({ status: 200, json: { country: 'JP', blocked: true } }), 10, never) === 'blocked', 'JP blocked');
	ok(await checkRegion(async () => ({ status: 200, json: { country: 'TW', blocked: false } }), 10, never) === 'allowed', 'TW allowed');
	ok(await checkRegion(async () => ({ status: 500, json: {} }), 10, never) === 'error', '500 -> error (fail closed)');
	ok(await checkRegion(async () => ({ status: 200, json: { blocked: 'no' } }), 10, never) === 'error', 'bad body -> error');
	ok(await checkRegion(async () => { throw new Error('net'); }, 10, never) === 'error', 'throw -> error');
	ok(await checkRegion(() => new Promise(() => {}), 10, now) === 'error', 'timeout -> error');

	const g = new BuyGate(async () => ({ status: 200, json: { blocked: true } }), never);
	let settled = 0; await g.ensure(() => settled++);
	ok(g.current === 'hide' && !g.visible() && !g.failed() && settled === 1, 'BuyGate JP: hidden, no error note');
	const g2 = new BuyGate(async () => { throw new Error('x'); }, never); await g2.ensure(() => {});
	ok(!g2.visible() && g2.failed(), 'BuyGate failure: hidden + note');

	const c = new ConsentState(); const opened: string[] = [];
	ok(!openCheckoutIfConsented(c, CHECKOUT_URL, (u) => opened.push(u)) && opened.length === 0, 'no checkout without consent');
	c.set(true);
	ok(openCheckoutIfConsented(c, CHECKOUT_URL, (u) => opened.push(u)) && opened.length === 1, 'checkout handler runs after consent');
	ok(CHECKOUT_READY === true, 'CHECKOUT_READY is true in the sale build');
	ok(CHECKOUT_URL === 'https://formchime.com/api/checkout?product=docxwise-pro', 'checkout URL is the gate docxwise-pro entry');

	// Placeholder config: benefit TBD -> not configured -> no network at all.
	let calls = 0;
	const tbd = { ...DEFAULT_LICENSE_CONFIG, productId: 'TBD-docxwise-product', benefitId: 'TBD-docxwise-benefit' };
	const lm0 = new LicenseManager({ ...EMPTY_LICENSE }, tbd, async () => { calls++; return { status: 200, json: {} }; }, () => Date.now(), async () => {});
	ok(!lm0.isConfigured(), 'placeholder IDs: not configured');
	await lm0.activate('KEY', 'Obsidian – Linux – test');
	ok(calls === 0 && !lm0.isPro(), 'placeholder IDs: activate makes no request, no Pro');
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const shipped = new LicenseManager({ ...EMPTY_LICENSE }, DEFAULT_LICENSE_CONFIG, async () => ({ status: 200, json: {} }), () => Date.now(), async () => {});
	ok(shipped.isConfigured() === UUID.test(DEFAULT_LICENSE_CONFIG.benefitId), 'shipped config: configured only with a real benefit UUID');
	ok(DEFAULT_LICENSE_CONFIG.benefitId !== '5ec5a70e-bb98-4923-b040-5c5679f9daa8', 'shipped config: not the Streakwise benefit');

	// With real-looking ids: benefit_id must match.
	const cfg = { ...DEFAULT_LICENSE_CONFIG, productId: '11111111-1111-1111-1111-111111111111', benefitId: '22222222-2222-2222-2222-222222222222' };
	const polar = (benefit: string): HttpPost => async (url) => url.endsWith('/activate')
		? { status: 200, json: { id: 'act-1' } }
		: { status: 200, json: { status: 'granted', organization_id: cfg.organizationId, benefit_id: benefit, expires_at: null } };
	const lmWrong = new LicenseManager({ ...EMPTY_LICENSE }, cfg, polar('33333333-3333-3333-3333-333333333333'), () => Date.now(), async () => {}, () => 0);
	await lmWrong.activate('KEY', 'x');
	ok(!lmWrong.isPro(), 'other product key (wrong benefit_id) rejected');
	const lmRight = new LicenseManager({ ...EMPTY_LICENSE }, cfg, polar(cfg.benefitId), () => Date.now(), async () => {}, () => 0);
	await lmRight.activate('KEY', 'x');
	ok(lmRight.isPro(), 'matching benefit_id unlocks Pro');

	console.log(fails ? `${fails} FAILED` : 'all license tests passed');
	process.exit(fails ? 1 : 0);
})();
