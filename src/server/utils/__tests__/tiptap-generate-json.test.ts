import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateJSON as tiptapGenerateJSON } from '@tiptap/html/server';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createParserWindow, generateJSON } from '~/server/utils/tiptap-generate-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

const SAMPLES: Record<string, string> = {
  paragraphs: '<p>Hello <strong>bold</strong> and <em>italic</em></p><p></p><p>second</p>',
  headings: '<h1>One</h1><h2 id="two">Two</h2><h3>Three</h3>',
  links: '<p><a href="https://civitai.com/models/1" target="_blank" rel="noopener">model</a></p>',
  lists:
    '<ul><li><p>a</p></li></ul><ol start="3"><li><p>b</p></li></ol><blockquote><p>q</p></blockquote>',
  code: '<pre><code class="language-ts">const a = 1;</code></pre><hr><p>a<br>b</p>',
  image: '<img src="https://image.civitai.com/x/y/width=450/z.jpeg" alt="pic" title="t">',
  'edge media':
    '<edge-media url="0b9e7d7e-1111-2222-3333-444455556666" type="image" filename="a.png"></edge-media>',
  youtube:
    '<div data-youtube-video=""><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="640" height="480" allowfullscreen="true"></iframe></div>',
  instagram:
    '<div data-type="instagram"><iframe src="https://www.instagram.com/p/abc/embed" width="400" height="500"></iframe></div>',
  strawpoll:
    '<div data-type="strawPoll"><iframe src="https://strawpoll.com/embed/abc" width="640" height="480"></iframe></div>',
  mention: '<p><span data-type="mention" data-id="42" data-label="someone">@someone</span></p>',
  timestamp:
    '<p><time data-type="timestamp" data-value="2026-01-01T00:00:00.000Z" data-style="relative"></time></p>',
  blurb: '<div data-type="blurb" data-id="7"></div>',
  'text style': '<p><span style="color: #ff0000">red</span></p>',
  'plain text': 'just text, no tags',
  'JSON-looking text': '{"type":"doc","content":[{"type":"sticker"}]}',
  'unbalanced markup': '<p><b>open <i>tags</p></div><iframe>',
  empty: '',
};

describe('generateJSON matches @tiptap/html/server', () => {
  for (const [name, html] of Object.entries(SAMPLES)) {
    it(`parses ${name} identically`, () => {
      expect(generateJSON(html, tiptapExtensions)).toEqual(
        tiptapGenerateJSON(html, tiptapExtensions)
      );
    });
  }
});

describe('parsing makes no network connections', () => {
  let server: http.Server;
  let connections: number;
  let requests: string[];
  let html: string;

  beforeEach(async () => {
    connections = 0;
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end('x');
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    html = `<iframe src="${origin}/i"></iframe><link rel="stylesheet" href="${origin}/c.css"><img src="${origin}/p.png">`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

  // The parser windows are left open here, so loads are not cut short by `close()`.
  function parseInOpenWindow(window: Window) {
    new window.DOMParser().parseFromString(
      `<!DOCTYPE html><html><body>${html}</body></html>`,
      'text/html'
    );
    return window;
  }

  it('control: a default happy-dom window loads the iframe and stylesheet', async () => {
    const window = parseInOpenWindow(new Window());
    await settle();
    await window.happyDOM.waitUntilComplete();
    await window.happyDOM.close();

    expect(requests).toEqual(expect.arrayContaining(['/i', '/c.css']));
  });

  it('the parser window loads nothing', async () => {
    const window = parseInOpenWindow(createParserWindow());
    await settle();
    await window.happyDOM.waitUntilComplete();
    await window.happyDOM.close();

    expect({ connections, requests }).toEqual({ connections: 0, requests: [] });
  });

  it('control: @tiptap/html/server opens connections before closing its window', async () => {
    tiptapGenerateJSON(html, tiptapExtensions);
    await settle();

    expect(connections).toBeGreaterThan(0);
  });

  it('generateJSON opens no connections', async () => {
    generateJSON(html, tiptapExtensions);
    await settle();

    expect({ connections, requests }).toEqual({ connections: 0, requests: [] });
  });
});
