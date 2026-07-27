/**
 * @fileoverview Tag-name lookup helpers shared by the SEC XML parsers. SEC ships the
 * same logical document under a default namespace on some filings and a prefixed one
 * on others (`<infoTable>` vs `<ns1:infoTable>`), so every lookup here matches on the
 * local name and ignores whatever prefix the filer used. htmlparser2's `xmlMode`
 * performs no DTD or external-entity expansion, so parsing untrusted filer XML is not
 * an XXE sink.
 * @module services/edgar/xml-nodes
 */

import type { AnyNode, Element } from 'domhandler';
import { findAll, findOne, textContent } from 'domutils';

/** Strip any namespace prefix and lowercase, so `ns1:infoTable` matches `infotable`. */
function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

/** Predicate matching any element whose local tag name equals `tagName`. */
function isTag(tagName: string): (node: AnyNode) => node is Element {
  const wanted = tagName.toLowerCase();
  return (node): node is Element => node.type === 'tag' && localName(node.name) === wanted;
}

/**
 * First descendant element with this local tag name, or undefined.
 *
 * Every lookup here takes an optional parent and answers "absent" for one, because a filer
 * omitting an outer element is ordinary — a caller reading a nested field would otherwise
 * guard each level by hand for a result these already return.
 */
export function findTag(
  nodes: AnyNode[] | undefined,
  tagName: string,
  recurse = true,
): Element | undefined {
  if (!nodes) return;
  return findOne(isTag(tagName), nodes, recurse) ?? undefined;
}

/** Every descendant element with this local tag name, in document order. */
export function findTags(nodes: AnyNode[] | undefined, tagName: string): Element[] {
  return nodes ? findAll(isTag(tagName), nodes) : [];
}

/** Trimmed text of the first descendant with this tag name, or undefined when absent or blank. */
export function childText(parent: Element | undefined, tagName: string): string | undefined {
  const child = findTag(parent?.children, tagName);
  if (!child) return;
  return textContent(child).trim() || undefined;
}

/** Trimmed text of every descendant with this tag name, skipping blanks. */
export function childTexts(parent: Element | undefined, tagName: string): string[] {
  const out: string[] = [];
  for (const el of findTags(parent?.children, tagName)) {
    const text = textContent(el).trim();
    if (text) out.push(text);
  }
  return out;
}

/** Value of `attr` on the first descendant with this tag name, or undefined. */
export function childAttr(
  parent: Element | undefined,
  tagName: string,
  attr: string,
): string | undefined {
  return findTag(parent?.children, tagName)?.attribs[attr]?.trim() || undefined;
}

/** Parse a numeric string, tolerating thousands separators. Undefined when not finite. */
export function parseNumber(value: string | undefined): number | undefined {
  if (!value) return;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** SEC cover pages date fields as MM/DD/YYYY; normalize to YYYY-MM-DD, else undefined. */
export function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return;
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}
