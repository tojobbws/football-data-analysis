import { Marked } from 'marked';

/**
 * Markdown -> HTML for articles. Raw HTML in the source is dropped (not rendered), and links are
 * limited to http(s)/relative, so an article can never inject scripts into the page.
 */
const md = new Marked({
  gfm: true,
  renderer: {
    html: () => '',
    link({ href, tokens }) {
      const safe = /^(https?:\/\/|\/|#)/i.test(href) ? href : '#';
      const external = /^https?:\/\//i.test(safe);
      // render the link text through the parser so inline HTML inside it is dropped too
      const inner = this.parser.parseInline(tokens);
      return `<a href="${escapeAttr(safe)}"${external ? ' rel="nofollow noopener" target="_blank"' : ''}>${inner}</a>`;
    },
    image({ href, text }) {
      return /^https:\/\//i.test(href) ? `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}" loading="lazy" />` : '';
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string;
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
