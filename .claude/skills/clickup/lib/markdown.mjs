/**
 * Markdown to ClickUp comment format conversion
 */

// Convert markdown to ClickUp comment format
export function markdownToClickUp(markdown) {
  const comment = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headers (## or **Header**)
    const headerMatch = line.match(/^#{1,3}\s+(.+)$/) || line.match(/^\*\*([^*]+)\*\*$/);
    if (headerMatch) {
      if (comment.length > 0) {
        comment.push({ text: '\n', attributes: {} });
      }
      comment.push({ text: headerMatch[1], attributes: { bold: true } });
      comment.push({ text: '\n', attributes: {} });
      i++;
      continue;
    }

    // Bullet list item
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const itemText = parseInlineFormatting(bulletMatch[1]);
      comment.push(...itemText);
      comment.push({ text: '\n', attributes: { list: { list: 'bullet' } } });
      i++;
      continue;
    }

    // Numbered list item
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      const itemText = parseInlineFormatting(numberedMatch[1]);
      comment.push(...itemText);
      comment.push({ text: '\n', attributes: { list: { list: 'ordered' } } });
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      comment.push({ text: '\n', attributes: {} });
      i++;
      continue;
    }

    // Regular paragraph with inline formatting
    const formatted = parseInlineFormatting(line);
    comment.push(...formatted);
    comment.push({ text: '\n', attributes: {} });
    i++;
  }

  // Clean up trailing newlines
  while (comment.length > 0 && comment[comment.length - 1].text === '\n' && !comment[comment.length - 1].attributes?.list) {
    comment.pop();
  }

  return comment;
}

// Parse inline formatting (bold, italic, code, links)
export function parseInlineFormatting(text) {
  const result = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*(.*)/s) ||
                      remaining.match(/^(.*?)__([^_]+)__(.*)/s);
    if (boldMatch) {
      if (boldMatch[1]) {
        result.push(...parseInlineFormatting(boldMatch[1]));
      }
      result.push({ text: boldMatch[2], attributes: { bold: true } });
      remaining = boldMatch[3];
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^(.*?)\*([^*]+)\*(.*)/s) ||
                        remaining.match(/^(.*?)_([^_]+)_(.*)/s);
    if (italicMatch && !italicMatch[1].endsWith('*')) {
      if (italicMatch[1]) {
        result.push(...parseInlineFormatting(italicMatch[1]));
      }
      result.push({ text: italicMatch[2], attributes: { italic: true } });
      remaining = italicMatch[3];
      continue;
    }

    // Inline code: `text`
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)/s);
    if (codeMatch) {
      if (codeMatch[1]) {
        result.push({ text: codeMatch[1], attributes: {} });
      }
      result.push({ text: codeMatch[2], attributes: { code: true } });
      remaining = codeMatch[3];
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)(.*)/s);
    if (linkMatch) {
      if (linkMatch[1]) {
        result.push({ text: linkMatch[1], attributes: {} });
      }
      result.push({ text: linkMatch[2], attributes: { link: linkMatch[3] } });
      remaining = linkMatch[4];
      continue;
    }

    // No more formatting, add rest as plain text
    result.push({ text: remaining, attributes: {} });
    break;
  }

  return result;
}
