/**
 * Markdown → ADF (Atlassian Document Format). Hermes's plan/progress text is markdown
 * (headings, bold/italic/code, bullet & ordered lists, links, code blocks). Jira comments are
 * ADF JSON, so without conversion the raw `##`/`**`/`` ` `` show up as literal characters.
 * Ported from the DonateMate MCP HTTP handler's converter (marked-based).
 */
import { marked } from 'marked';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function applyMark(nodes: any[], mark: any): any[] {
  return nodes.map((n) => (n.type === 'text' ? { ...n, marks: [...(n.marks || []), mark] } : n));
}

function inlineToAdf(tokens: any[]): any[] {
  const out: any[] = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
        if (t.tokens?.length) out.push(...inlineToAdf(t.tokens));
        else {
          const text = decodeEntities(t.text ?? '');
          if (text) out.push({ type: 'text', text });
        }
        break;
      case 'escape': {
        const text = decodeEntities(t.text ?? '');
        if (text) out.push({ type: 'text', text });
        break;
      }
      case 'strong':
        out.push(...applyMark(inlineToAdf(t.tokens), { type: 'strong' }));
        break;
      case 'em':
        out.push(...applyMark(inlineToAdf(t.tokens), { type: 'em' }));
        break;
      case 'del':
        out.push(...applyMark(inlineToAdf(t.tokens), { type: 'strike' }));
        break;
      case 'codespan': {
        const text = decodeEntities(t.text ?? '');
        if (text) out.push({ type: 'text', text, marks: [{ type: 'code' }] });
        break;
      }
      case 'link':
        out.push(...applyMark(inlineToAdf(t.tokens), { type: 'link', attrs: { href: t.href } }));
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      default: {
        const text = decodeEntities(t.text ?? '');
        if (text) out.push({ type: 'text', text });
      }
    }
  }
  return out;
}

function listItemContent(item: any): any[] {
  const out: any[] = [];
  let buffer: any[] = [];
  const flush = () => {
    if (buffer.length) {
      out.push({ type: 'paragraph', content: buffer });
      buffer = [];
    }
  };
  for (const child of item.tokens || []) {
    if (child.type === 'list') {
      flush();
      out.push(listToAdf(child));
    } else if (child.type === 'text') {
      buffer.push(...inlineToAdf(child.tokens || (child.text ? [{ type: 'text', text: child.text }] : [])));
    } else if (child.type === 'paragraph') {
      flush();
      out.push({ type: 'paragraph', content: inlineToAdf(child.tokens) });
    } else {
      flush();
      out.push(...blockToAdf([child]));
    }
  }
  flush();
  if (out.length === 0) out.push({ type: 'paragraph', content: [] });
  return out;
}

function listToAdf(list: any): any {
  const items: any[] = list.items || [];
  const node: any = {
    type: list.ordered ? 'orderedList' : 'bulletList',
    content: items.map((it) => ({ type: 'listItem', content: listItemContent(it) })),
  };
  if (list.ordered && typeof list.start === 'number' && list.start !== 1) {
    node.attrs = { order: list.start };
  }
  return node;
}

function blockToAdf(tokens: any[]): any[] {
  const content: any[] = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'heading':
        content.push({ type: 'heading', attrs: { level: Math.min(Math.max(t.depth || 1, 1), 6) }, content: inlineToAdf(t.tokens) });
        break;
      case 'paragraph':
        content.push({ type: 'paragraph', content: inlineToAdf(t.tokens) });
        break;
      case 'list':
        content.push(listToAdf(t));
        break;
      case 'code':
        content.push({
          type: 'codeBlock',
          ...(t.lang ? { attrs: { language: String(t.lang).split(/\s+/)[0] } } : {}),
          content: t.text ? [{ type: 'text', text: t.text }] : [],
        });
        break;
      case 'blockquote':
        content.push({ type: 'blockquote', content: blockToAdf(t.tokens) });
        break;
      case 'hr':
        content.push({ type: 'rule' });
        break;
      case 'space':
        break;
      default: {
        const inline = t.tokens ? inlineToAdf(t.tokens) : t.text ? [{ type: 'text', text: decodeEntities(t.text) }] : [];
        if (inline.length) content.push({ type: 'paragraph', content: inline });
      }
    }
  }
  return content;
}

/** Convert a markdown string into an ADF document for a Jira comment/description. */
export function markdownToAdf(md: string): unknown {
  const tokens = marked.lexer(md || '', { gfm: true, breaks: true });
  let content = blockToAdf(tokens as any[]);
  if (content.length === 0) content = [{ type: 'paragraph', content: [] }];
  return { version: 1, type: 'doc', content };
}
