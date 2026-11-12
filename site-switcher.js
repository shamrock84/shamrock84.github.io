// The header site switcher shared by myFFL, myVST, myBangers and myFAM (the
// melbostads.com home page, index.html).
//
// Each page loads this from <head> with a plain (non-deferred) script tag and
// says which site it is: <script src="/site-switcher.js" data-site="ffl">.
// On DOMContentLoaded it lifts the page's own `header .site-title` h1 (the
// "my" + logo markup, so the existing .site-logo dark-mode rules still apply)
// into a strip, flanked by the previous and next site's logo, faded, each with
// an arrow. A click on an arrow or neighbour, or a horizontal swipe on the
// strip, navigates there. Four sites cycle: the last one's "next" is the
// first. It behaves the same logged in or out; it only links to public pages.
//
// Why it is a plain script in <head> and not deferred: the slide transition
// below needs its `pagereveal` listener registered before the new page's first
// render, and its CSS rule present in both the page being left and the one
// being entered.
//
// Failure modes, all deliberate:
//  - If this file doesn't load (the Vercel copy of myffl.html doesn't serve
//    it), the page's own h1 stays exactly as it was. Nothing is hidden until
//    the strip is built.
//  - The links are real hrefs, so open-in-new-tab and no-JS clicks work; the
//    click handler only intercepts a plain left click, to add the slide.
//  - Adding a site is one entry in SITES. Order is display order; the page's
//    own data-site must match a `key`. test-site-switcher.mjs pins that each
//    page's logo is the SITES entry's logo.
//  - The swipe is on the strip only, never the page: myFFL has horizontally
//    scrolling tables, and `touch-action: pan-y` hands vertical scrolling back
//    to the browser while keeping horizontal drags for us.
//
// The strip is capped at a large phone's width (430px) and centred, so on a
// desktop it looks exactly as it does on a phone instead of stretching the
// neighbours and arrows across the whole header.
//
// Not done on purpose: no prefetch of the neighbours (myffl.html is ~1MB and
// a visit to myVST would pay for it every time), and no ← → keyboard shortcut
// (it fights text fields and the tables' own scrolling).

(function () {
	'use strict';

	// href and img are root-relative; see base() for the Vercel copy.
	var SITES = [
		{ key: 'ffl', name: 'myFFL', href: '/myffl.html', img: '/images/ffl_black.gif', alt: 'FFL' },
		{ key: 'vst', name: 'myVST', href: '/vikings.html', img: '/images/seasonticketlogo.png', alt: 'VST — Vikings Season Tickets' },
		{ key: 'bangers', name: 'myBangers', href: '/bangers.html', img: '/images/bangerslogo.png', alt: 'Certified Banger' },
		// The home page. Its logo is a black-on-transparent SVG, so the pages' dark-mode invert filter works on it like the PNGs.
		{ key: 'fam', name: 'myFAM', href: '/', img: '/images/famlogo.svg', alt: 'FAM — Melbostads' },
	];

	// The sites either side of `key`, wrapping. Pure, so the test can run it.
	function neighbours(order, key) {
		var n = order.length;
		var i = -1;
		for (var j = 0; j < n; j++) if (order[j].key === key) i = j;
		if (i < 0) return null;
		return { current: order[i], prev: order[(i + n - 1) % n], next: order[(i + 1) % n] };
	}

	var api = { SITES: SITES, neighbours: neighbours };
	if (typeof globalThis !== 'undefined') globalThis.SiteSwitcher = api;

	var script = typeof document !== 'undefined' ? document.currentScript : null;
	if (!script) return; // not in a browser page (the test loads this in a vm)
	var siteKey = script.getAttribute('data-site');
	var around = neighbours(SITES, siteKey);
	if (!around) return;

	var SWIPE_PX = 40;
	var SLIDE_KEY = 'siteSwitchDir';
	var root = document.documentElement;

	// The Vercel copy of myffl.html can't serve the sibling pages or images, so
	// it points at the real site.
	function base() {
		return /\.vercel\.app$/.test(location.hostname) ? 'https://melbostads.com' : '';
	}

	// ---- styles ---------------------------------------------------------------
	// Neighbour logos reuse the page's own .site-logo / .site-logo-prefix, so
	// size, font and dark-mode inversion come from each page, not from here.
	var css = [
		'@view-transition { navigation: auto; }',
		'@keyframes sw-out-next { to { transform: translateX(-28%); opacity: 0; } }',
		'@keyframes sw-in-next { from { transform: translateX(28%); opacity: 0; } }',
		'@keyframes sw-out-prev { to { transform: translateX(28%); opacity: 0; } }',
		'@keyframes sw-in-prev { from { transform: translateX(-28%); opacity: 0; } }',
		'html[data-sw-dir="next"]::view-transition-old(root) { animation: .26s ease-in both sw-out-next; }',
		'html[data-sw-dir="next"]::view-transition-new(root) { animation: .26s ease-out both sw-in-next; }',
		'html[data-sw-dir="prev"]::view-transition-old(root) { animation: .26s ease-in both sw-out-prev; }',
		'html[data-sw-dir="prev"]::view-transition-new(root) { animation: .26s ease-out both sw-in-prev; }',
		'.sw-host { align-self: stretch; width: 100%; }',
		'.site-switcher { position: relative; width: 100%; max-width: 430px; margin: 0 auto; height: 88px; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none; }',
		'.sw-track { position: absolute; inset: 0;',
		'  -webkit-mask-image: linear-gradient(to right, transparent 7%, #000 34%, #000 66%, transparent 93%);',
		'  mask-image: linear-gradient(to right, transparent 7%, #000 34%, #000 66%, transparent 93%); }',
		'.sw-item { position: absolute; top: 50%; left: calc(50% + var(--sw-x, 0) * min(32%, 250px));',
		'  transform: translate(-50%, -50%); margin: 0; display: flex; align-items: center; justify-content: center;',
		'  white-space: nowrap; text-decoration: none; color: inherit; }',
		'.sw-item.sw-side { opacity: .5; transform: translate(-50%, -50%) scale(.82); }',
		'.sw-arrow { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; width: 22px; height: 60px;',
		'  padding: 0; display: grid; place-items: center; cursor: pointer; border: 0; background: none;',
		'  color: var(--accent, #4F2683); opacity: .85; }',
		'.sw-arrow:hover { opacity: 1; }',
		'.sw-arrow.sw-l { left: 0; } .sw-arrow.sw-r { right: 0; }',
		'.sw-arrow svg { width: 11px; height: 40px; }',
		'@media (prefers-reduced-motion: reduce) { .sw-item { transition: none; } }',
	].join('\n');
	var style = document.createElement('style');
	style.textContent = css;
	document.head.appendChild(style);

	// ---- navigation -------------------------------------------------------------
	var navigating = false;
	function go(site, dir) {
		if (navigating) return;
		navigating = true;
		try {
			sessionStorage.setItem(SLIDE_KEY, JSON.stringify({ d: dir, t: Date.now() }));
		} catch (e) { /* private mode: navigate without the slide */ }
		location.assign(base() + site.href);
	}

	// Only a navigation this switcher started gets the slide; a reload, a back
	// button or a link from elsewhere keeps the browser's default (none).
	window.addEventListener('pagereveal', function (e) {
		if (!e.viewTransition) return;
		var d = 0;
		try {
			var saved = JSON.parse(sessionStorage.getItem(SLIDE_KEY));
			sessionStorage.removeItem(SLIDE_KEY);
			if (saved && Date.now() - saved.t < 5000) d = saved.d;
		} catch (err) { /* treated as no slide */ }
		var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!d || reduced) { e.viewTransition.skipTransition(); return; }
		root.setAttribute('data-sw-dir', d > 0 ? 'next' : 'prev');
		e.viewTransition.finished.then(function () { root.removeAttribute('data-sw-dir'); },
			function () { root.removeAttribute('data-sw-dir'); });
	});

	// ---- the strip --------------------------------------------------------------
	function arrowSvg(dir) {
		var ns = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('viewBox', '0 0 11 40');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2.4');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		var line = document.createElementNS(ns, 'polyline');
		line.setAttribute('points', dir < 0 ? '9 3 2 20 9 37' : '2 3 9 20 2 37');
		svg.appendChild(line);
		return svg;
	}

	function neighbourLink(site, x, dir) {
		var a = document.createElement('a');
		a.className = 'sw-item sw-side';
		a.href = base() + site.href;
		a.setAttribute('aria-label', site.name);
		a.style.setProperty('--sw-x', String(x));
		var pre = document.createElement('span');
		pre.className = 'site-logo-prefix';
		pre.textContent = 'my';
		var img = document.createElement('img');
		img.className = 'site-logo';
		img.src = base() + site.img;
		img.alt = '';
		a.appendChild(pre);
		a.appendChild(img);
		a.addEventListener('click', function (e) {
			if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			go(site, dir);
		});
		return a;
	}

	function arrowButton(site, dir) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'sw-arrow ' + (dir < 0 ? 'sw-l' : 'sw-r');
		b.setAttribute('aria-label', dir < 0 ? 'Previous site: ' + site.name : 'Next site: ' + site.name);
		b.appendChild(arrowSvg(dir));
		b.addEventListener('click', function () { go(site, dir); });
		return b;
	}

	function build() {
		var title = document.querySelector('header .site-title');
		if (!title || document.querySelector('.site-switcher')) return;

		var strip = document.createElement('div');
		strip.className = 'site-switcher';
		strip.setAttribute('role', 'navigation');
		strip.setAttribute('aria-label', 'Switch site');
		var track = document.createElement('div');
		track.className = 'sw-track';

		// The page's own h1 becomes the centre item. Parents that aren't the
		// header (myVST wraps it in a div) must be told to span the width.
		var parent = title.parentNode;
		if (parent.tagName !== 'HEADER') parent.classList.add('sw-host');
		parent.insertBefore(strip, title);
		title.classList.add('sw-item');
		title.style.setProperty('--sw-x', '0');

		track.appendChild(neighbourLink(around.prev, -1, -1));
		track.appendChild(title);
		track.appendChild(neighbourLink(around.next, 1, 1));
		strip.appendChild(track);
		strip.appendChild(arrowButton(around.prev, -1));
		strip.appendChild(arrowButton(around.next, 1));

		// Swipe: a mostly-horizontal drag of SWIPE_PX or more on the strip.
		// Left (negative dx) reveals the next site, like turning a page.
		var x0 = null, y0 = 0;
		strip.addEventListener('pointerdown', function (e) {
			if (e.target.closest && e.target.closest('.sw-arrow')) return;
			x0 = e.clientX;
			y0 = e.clientY;
		});
		strip.addEventListener('pointercancel', function () { x0 = null; });
		window.addEventListener('pointerup', function (e) {
			if (x0 === null) return;
			var dx = e.clientX - x0, dy = e.clientY - y0;
			x0 = null;
			if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
				if (dx < 0) go(around.next, 1); else go(around.prev, -1);
			}
		});
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
	else build();
})();
