// Pins the header site switcher (site-switcher.js), shared by myFFL, myVST,
// myBangers and myFAM. What can drift silently:
//  - the cycle: four sites wrap, so the first's "prev" is the last;
//  - a page's data-site not matching a SITES key (the strip then never builds
//    and nobody notices, because the page's own h1 stays);
//  - a page's own logo differing from the SITES entry, so the neighbour's
//    thumbnail on the other pages shows a different image than the page itself;
//  - every site's page loading the script, since the slide transition needs
//    both the page being left and the one entered to carry its CSS rule.
// There is no DOM: the script is evaluated in a vm (it returns early without
// document.currentScript) and its pure helper is called directly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'site-switcher.js'), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context);
const { SITES, neighbours } = context.SiteSwitcher;

// The cycle.
const keys = [...SITES].map((s) => s.key);
assert.deepEqual(keys, ['ffl', 'vst', 'bangers', 'fam']);
const at = (k) => { const n = neighbours(SITES, k); return [n.prev.key, n.current.key, n.next.key]; };
assert.deepEqual(at('ffl'), ['fam', 'ffl', 'vst']);
assert.deepEqual(at('vst'), ['ffl', 'vst', 'bangers']);
assert.deepEqual(at('bangers'), ['vst', 'bangers', 'fam']);
assert.deepEqual(at('fam'), ['bangers', 'fam', 'ffl']);
assert.equal(neighbours(SITES, 'nope'), null);
// Two sites still work (prev and next are the same page).
const two = SITES.slice(0, 2);
assert.equal(neighbours(two, 'ffl').prev.key, 'vst');
assert.equal(neighbours(two, 'ffl').next.key, 'vst');

// Every page loads the script and declares itself, and its own logo is the one
// the switcher draws for it elsewhere.
const pages = { ffl: 'myffl.html', vst: 'vikings.html', bangers: 'bangers.html', fam: 'index.html' };
for (const site of SITES) {
	const html = fs.readFileSync(path.join(root, pages[site.key]), 'utf8');
	assert.ok(
		html.includes(`<script src="/site-switcher.js" data-site="${site.key}"></script>`),
		`${pages[site.key]} must load site-switcher.js with data-site="${site.key}"`,
	);
	assert.equal(html.split('<script src="/site-switcher.js"').length - 1, 1, `${pages[site.key]} loads it once`);
	const logo = html.match(/<h1[^>]*class="site-title"[^>]*>[\s\S]*?<img src="([^"]+)"/);
	assert.ok(logo, `${pages[site.key]} has a site-title h1 with a logo`);
	assert.equal('/' + logo[1], site.img, `${pages[site.key]}'s own logo matches SITES`);
	// (images/ isn't checked out in CI's sparse checkout, so file existence can't be asserted for logos.)
	// The home page's href is '/', which is index.html.
	assert.ok(fs.existsSync(path.join(root, site.href === '/' ? 'index.html' : site.href.slice(1))), `${site.href} exists`);
}

console.log('site switcher ok');
