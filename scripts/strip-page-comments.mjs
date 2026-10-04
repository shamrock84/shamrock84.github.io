// Strips comments from myffl.html's inline <script> and <style> blocks, for
// deploy only. Run by deploy-pages.yml on the checked-out copy just before
// Jekyll builds the site; the file in the repository is never changed.
//
// Why: the source is roughly half comments by design (CLAUDE.md — the comment
// at the code is the authority), and every visitor was downloading them: about
// 170KB of a ~250KB gzipped page. Stripping them at deploy keeps the
// repository's comment-heavy convention without making visitors pay for it.
//
// How: comments are CUT OUT, not re-printed. Every byte that isn't a comment
// stays exactly as written — quotes, tabs, line breaks — so the page that
// ships is the page the tests read, minus comments, and the test suite can be
// re-run against the stripped copy as the deploy's guard (it source-matches
// the page in places, which any re-printer would break).
//   - JS comment positions come from acorn, a real parser, because `//` and
//     `/*` also occur inside strings, template literals and regular
//     expressions, and a regex that guesses wrong breaks the live page.
//     acorn is installed by the workflow at a pinned version and is never a
//     dependency of the repository itself.
//   - CSS comments are lexed here: the only places `/*` can hide in CSS are
//     strings and url(), and both are handled.
//   - Line structure is kept where it matters: a removed comment that
//     contained a line break leaves one behind, so automatic semicolon
//     insertion sees exactly what it saw before. A line left empty by a
//     removal is dropped; a blank line that was already there is kept.
//
// Before anything is written, the stripped JS is re-tokenized and compared
// token-for-token with the original. Any difference — or any parse failure —
// exits non-zero with nothing written, so the deploy stops and the previously
// published page stays up.
//
// Usage: node scripts/strip-page-comments.mjs <in.html> <out.html>
// (in and out may be the same path).

import { readFile, writeFile } from 'node:fs/promises';

const BLOCK = /(<(script|style)(\s[^>]*)?>)([\s\S]*?)(<\/\2>)/gi;
// Private-use placeholders: a comment that leaves nothing behind, and one
// that leaves a single space (an inline block comment, so `a/**/b` can't
// fuse into `ab`). Checked absent from the input before use.
const GONE = '\uE000';
const SPACE = '\uE001';

// Replaces each [start, end) range with a placeholder, then cleans up line by
// line. Ranges must be sorted and non-overlapping.
export function removeRanges(code, ranges) {
  if (code.includes(GONE) || code.includes(SPACE)) {
    throw new Error('input contains the private-use placeholder characters');
  }
  let out = '';
  let last = 0;
  for (const { start, end } of ranges) {
    out += code.slice(last, start);
    const text = code.slice(start, end);
    out += /[\n\r\u2028\u2029]/.test(text) ? `${GONE}\n${GONE}` : (text.startsWith('/*') ? SPACE : GONE);
    last = end;
  }
  out += code.slice(last);
  return out
    .split('\n')
    .filter((line) => !((line.includes(GONE) || line.includes(SPACE)) && line.replace(/[\uE000\uE001]/g, '').trim() === ''))
    .map((line) => line.replace(/\uE000/g, '').replace(/\uE001/g, ' ').replace(/[ \t]+$/, (ws) => (line.includes(GONE) || line.includes(SPACE) ? '' : ws)))
    .join('\n');
}

// CSS comment ranges, skipping strings and unquoted url(...).
export function cssCommentRanges(css) {
  const ranges = [];
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < css.length && css[i] !== c) i += css[i] === '\\' ? 2 : 1;
      i++;
    } else if (/^url\(/i.test(css.slice(i, i + 4)) && !/^url\(\s*["']/i.test(css.slice(i, i + 12))) {
      const close = css.indexOf(')', i);
      i = close === -1 ? css.length : close + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) throw new Error('unterminated CSS comment');
      ranges.push({ start: i, end: close + 2 });
      i = close + 2;
    } else {
      i++;
    }
  }
  return ranges;
}

function jsTokens(acorn, code) {
  const tokens = [];
  for (const t of acorn.tokenizer(code, { ecmaVersion: 'latest', sourceType: 'script' })) {
    tokens.push(`${t.type.label}\u0000${t.value === undefined ? '' : String(t.value)}`);
  }
  return tokens;
}

export function stripJs(acorn, code) {
  const ranges = [];
  acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    onComment: (_block, _text, start, end) => ranges.push({ start, end }),
  });
  const out = removeRanges(code, ranges);
  // The proof: the same tokens, in the same order, before and after.
  const before = jsTokens(acorn, code);
  const after = jsTokens(acorn, out);
  if (before.length !== after.length || before.some((t, i) => t !== after[i])) {
    const at = before.findIndex((t, i) => t !== after[i]);
    throw new Error(`stripped JS differs from the original at token ${at}`);
  }
  acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'script' });
  return out;
}

export function stripPageComments(html, acorn) {
  const stats = { scripts: 0, styles: 0, before: html.length };
  const out = html.replace(BLOCK, (whole, open, tag, attrs = '', body, close) => {
    const kind = tag.toLowerCase();
    if (kind === 'style') {
      stats.styles++;
      return open + removeRanges(body, cssCommentRanges(body)) + close;
    }
    // External scripts (src=) and non-JS types (JSON, templates, modules —
    // this page has none of the last) pass through untouched.
    const type = (attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (/\ssrc\s*=/i.test(attrs) || (type && !/^(text|application)\/javascript$/i.test(type)) || !body.trim()) {
      return whole;
    }
    stats.scripts++;
    return open + stripJs(acorn, body) + close;
  });
  stats.after = out.length;
  return { html: out, stats };
}

async function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('usage: node scripts/strip-page-comments.mjs <in.html> <out.html>');
    process.exit(2);
  }
  const acorn = await import('acorn');
  const source = await readFile(inPath, 'utf8');
  const { html, stats } = stripPageComments(source, acorn);
  // Sanity bounds on top of the token proof: no script block at all means the
  // page changed shape, and no shrinkage means nothing was stripped.
  if (stats.scripts === 0) throw new Error('no inline script block found — has the page changed shape?');
  if (stats.after >= stats.before) throw new Error('output did not shrink: nothing was stripped');
  await writeFile(outPath, html);
  const pct = Math.round((1 - stats.after / stats.before) * 100);
  console.log(`${inPath}: ${stats.scripts} script, ${stats.styles} style block(s); ${stats.before} -> ${stats.after} bytes (-${pct}%)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`strip-page-comments: ${err.message}`);
    process.exit(1);
  });
}
