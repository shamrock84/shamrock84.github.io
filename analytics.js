// GoatCounter analytics loader, shared by the pages that have a login.
// Counts every visit, the manager's own included (a deliberate choice: they
// are nearly all the traffic and are the ones who want to see it). Lives in an
// external file because scripts/test-*.mjs extract the first inline <script>
// of myffl.html as the page script.
(function () {
	var s = document.createElement('script');
	s.async = true;
	s.src = '//gc.zgo.at/count.js';
	s.setAttribute('data-goatcounter', 'https://melbostads.goatcounter.com/count');
	document.head.appendChild(s);
})();
