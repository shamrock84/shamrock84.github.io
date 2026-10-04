// Pins the dependency-free half of scripts/strip-page-comments.mjs, which
// deploy-pages.yml runs on myffl.html before publishing:
//   - removeRanges keeps every byte that isn't a comment, keeps a line break
//     wherever a removed comment had one (automatic semicolon insertion
//     depends on it), drops lines a removal left empty, and keeps blank
//     lines that were already there;
//   - cssCommentRanges finds CSS comments but never inside strings or url().
//
// The JS half (comment positions from acorn, then a token-for-token proof)
// needs acorn, which the repository deliberately doesn't depend on; the
// deploy workflow installs it and then re-runs this whole test suite against
// the stripped page, which is the end-to-end check.

import assert from 'node:assert/strict';
import { removeRanges, cssCommentRanges } from './strip-page-comments.mjs';

// Comment ranges for small hand-written JS snippets, found the dumb way —
// fine here because no snippet below hides comment markers in strings.
function naiveJsRanges(code) {
	const ranges = [];
	const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
	for (const m of code.matchAll(re)) ranges.push({ start: m.index, end: m.index + m[0].length });
	return ranges;
}
const stripJs = (code) => removeRanges(code, naiveJsRanges(code));
const stripCss = (css) => removeRanges(css, cssCommentRanges(css));

// Whole-line comments disappear with their line; code lines are untouched.
assert.equal(
	stripJs('\t\t// a note\n\t\tconst a = 1;\n\t\t/* block\n\t\t   note */\n\t\tconst b = 2;\n'),
	'\t\tconst a = 1;\n\t\tconst b = 2;\n',
);

// A trailing comment goes, along with the whitespace before it.
assert.equal(stripJs("const s = 'x'; // why\nnext();"), "const s = 'x';\nnext();");

// An inline block comment becomes a space, so tokens can't fuse.
assert.equal(stripJs('a/**/b'), 'a b');

// A multi-line block comment between tokens on the same statement still
// leaves a line break: `return /*\n*/ x` returns undefined in JS (ASI), and
// stripping must not turn it into `return x`.
const asi = stripJs('return /* why\n   it is */ x;');
assert.ok(/return[ \t]*\n[ \t]*x;/.test(asi), `line break preserved for ASI, got ${JSON.stringify(asi)}`);

// Blank lines that were already there survive; only removal-emptied lines go.
assert.equal(stripJs('a();\n\n// gone\nb();'), 'a();\n\nb();');

// Exact bytes kept: quotes, tabs, indentation.
const kept = "\t\tconst VIEW_ORDER = ['rosters', 'scoring'];\n";
assert.equal(stripJs(`\t\t// order\n${kept}`), kept);

// CSS: comments go; markers inside strings and url() stay.
assert.equal(
	stripCss('.a { color: red; } /* note */\n/* whole line */\n.b { content: "/* not a comment */"; }\n'),
	'.a { color: red; }\n.b { content: "/* not a comment */"; }\n',
);
assert.equal(stripCss(".c { content: '/*'; } .d { background: url(x/*y.png); }"), ".c { content: '/*'; } .d { background: url(x/*y.png); }");
// A quoted url() is just a string, and the inline comment after it becomes a
// space (two spaces in a row are harmless in CSS).
assert.equal(stripCss('.e { background: url("a.png") /* x */; }'), '.e { background: url("a.png")  ; }');
assert.equal(stripCss('.f { content: "a\\"/*b"; } /* c */'), '.f { content: "a\\"/*b"; }');
assert.throws(() => cssCommentRanges('.g { } /* never closed'), /unterminated/);

// The placeholders are private-use characters; input carrying them is refused
// rather than silently corrupted.
assert.throws(() => removeRanges('\uE000', []), /placeholder/);

console.log('strip-page-comments: all assertions passed');
