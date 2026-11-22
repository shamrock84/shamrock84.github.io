// GoatCounter analytics loader, shared by the pages that have a login.
// Skipped for the logged-in manager so their own visits don't swamp the counts.
// Lives in an external file because scripts/test-*.mjs extract the first
// inline <script> of myffl.html as the page script.
(function () {
	try { if (localStorage.getItem('mflAuthToken')) return; } catch (e) { /* storage blocked: count the visit */ }
	var s = document.createElement('script');
	s.async = true;
	s.src = '//gc.zgo.at/count.js';
	s.setAttribute('data-goatcounter', 'https://melbostads.goatcounter.com/count');
	document.head.appendChild(s);
})();
