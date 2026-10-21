// A small reader for the pages report.mjs writes, so tests can ask about structure (what is a
// tag, what is text, what sits inside a closed <details>) instead of searching the page as a
// string. It reads the subset the reports use: double-quoted attributes, no comments, no CDATA.

import assert from 'node:assert/strict';

// Elements that have no closing tag. Most of them may not appear in a report at all; they are
// listed so that one that does is reported by its name and not as a tag left open.
const VOID = new Set(['meta', 'br', 'hr', 'wbr', 'col', 'img', 'link', 'input', 'source', 'embed', 'base', 'area', 'track']);
const TAG = /<(\/?)([A-Za-z][\w-]*)((?:\s+[A-Za-z_:][\w:.-]*(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)(?:="([^"]*)")?/g;

// Every tag and attribute a report may contain. Anything else fails the self-contained check.
export const ALLOWED_TAGS = new Set([
  'html', 'head', 'meta', 'title', 'style', 'body', 'main', 'footer', 'header', 'section', 'article', 'nav',
  'h1', 'h2', 'h3', 'h4', 'p', 'span', 'strong', 'em', 'code', 'pre', 'div', 'br',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'details', 'summary',
  'svg', 'g', 'path', 'rect', 'text', 'tspan',
]);
export const ALLOWED_ATTRIBUTES = new Set([
  'lang', 'charset', 'name', 'content', 'class', 'id', 'href', 'open', 'role', 'style', 'scope', 'title',
  'aria-label', 'aria-hidden',
  'data-node', 'data-kind', 'data-from', 'data-to', 'data-check', 'data-severity', 'data-skill', 'data-group', 'data-file',
  'viewBox', 'width', 'height', 'x', 'y', 'rx', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'font-family', 'font-size', 'text-anchor',
]);

// { elements, text, css }. Each element: { name, attrs, classes, parent, ancestors, text } where
// `text` is the text directly inside it. Throws when the page is not well formed.
export function parseHtml(html) {
  const doctype = /^<!doctype html>\s*/i.exec(html);
  assert.ok(doctype, 'the page does not start with <!doctype html>');
  let body = html.slice(doctype[0].length);

  // The one <style> block holds raw text; it is taken out before the tags are read.
  let css = '';
  body = body.replace(/<style>([\s\S]*?)<\/style>/g, (_, text) => {
    css += text;
    return '<style></style>';
  });

  const elements = [];
  const open = [];
  const loose = [];
  let last = 0;
  for (const match of body.matchAll(TAG)) {
    const between = body.slice(last, match.index);
    loose.push(between);
    if (open.length) open[open.length - 1].text += between;
    last = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match;
    if (closing) {
      assert.equal(attributes, '', `</${name}> carries attributes`);
      const top = open.pop();
      assert.equal(top?.name, name, `</${name}> does not close the tag that is open (${top?.name})`);
      continue;
    }
    const attrs = {};
    for (const entry of attributes.matchAll(ATTRIBUTE)) attrs[entry[1]] = entry[2] ?? '';
    const parent = open[open.length - 1] ?? null;
    const element = {
      name,
      attrs,
      classes: (attrs.class ?? '').split(/\s+/).filter(Boolean),
      parent,
      ancestors: [...open],
      text: '',
    };
    elements.push(element);
    if (!selfClosing && !VOID.has(name)) open.push(element);
  }
  loose.push(body.slice(last));
  assert.deepEqual(
    open.map((element) => element.name),
    [],
    'a tag is left open',
  );
  // Outside the tags there is only text: no bare angle bracket, no ampersand that is not an entity.
  const bare = /[<>]|&(?!(?:amp|lt|gt|quot|#39|#\d+);)/;
  for (const chunk of loose) assert.ok(!bare.test(chunk), `text outside the tags is not escaped: ${chunk.slice(0, 120)}`);
  for (const element of elements) {
    for (const [name, value] of Object.entries(element.attrs)) {
      assert.ok(!bare.test(value), `<${element.name} ${name}> is not escaped: ${value.slice(0, 120)}`);
    }
  }
  return { elements, text: loose.join('\n'), css };
}

// How many closed <details> hide the element. An element inside the <summary> of a closed
// <details> is still visible, so that level does not count.
export function closedDetailsDepth(element) {
  let depth = 0;
  const chain = [...element.ancestors, element];
  chain.forEach((ancestor, index) => {
    if (ancestor.name !== 'details' || 'open' in ancestor.attrs || ancestor === element) return;
    const child = chain[index + 1];
    if (child && child.name === 'summary') return;
    depth += 1;
  });
  return depth;
}

// The page is one offline file: no script, no external reference, no handler. The check reads
// tags and attributes, never the text, so a quoted line that says "<script src=...>" or
// " onload=" is text like any other and cannot fail it.
export function assertSelfContained(html) {
  const page = parseHtml(html);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(page.css, /prefers-color-scheme: dark/);
  for (const pattern of [/url\(/i, /@import/i, /expression\(/i, /https?:/i, /\/\//]) {
    assert.ok(!pattern.test(page.css), `the stylesheet contains ${pattern}`);
  }
  assert.equal(page.elements.filter((element) => element.name === 'style').length, 1, 'one stylesheet, in the head');
  for (const element of page.elements) {
    assert.ok(ALLOWED_TAGS.has(element.name), `the report contains <${element.name}>`);
    for (const [name, value] of Object.entries(element.attrs)) {
      assert.ok(ALLOWED_ATTRIBUTES.has(name), `<${element.name}> has the attribute ${name}`);
      assert.ok(!/^on/i.test(name), `<${element.name}> has the event handler ${name}`);
      if (name === 'href') assert.match(value, /^#[\w-]+$/, `a link leaves the page: ${value}`);
      if (name === 'style') {
        assert.match(value, /^(width:\d+(\.\d+)?%|left:\d+(\.\d+)?%|min-width:\d+px|max-width:\d+px;height:auto)$/, `a style attribute holds more than a size: ${value}`);
      }
      if (['fill', 'stroke'].includes(name)) assert.ok(!/url\(/i.test(value), `<${element.name} ${name}> points at a resource`);
    }
  }
  return page;
}
