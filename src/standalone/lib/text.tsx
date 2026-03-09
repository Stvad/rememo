import React from 'react';

const TOKEN_RE = /(\^\^.+?\^\^|\{.+?\}|\[\[.+?\]\]|\(\(.+?\)\))/g;
const SPECIAL_TOKEN_RE = /^(\^\^.+?\^\^|\{.+?\}|\[\[.+?\]\]|\(\(.+?\)\))$/;
const INLINE_TOKEN_RE =
  /(\[[^\]]+\]\((?:https?:\/\/|www\.)[^\s)]+\)|(?:https?:\/\/|www\.)[^\s<]+|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
const MARKDOWN_LINK_RE = /^\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)$/;
const BOLD_RE = /^(\*\*|__)([\s\S]+)\1$/;
const ITALIC_RE = /^(\*|_)([\s\S]+)\1$/;

const normalizeUrl = (url: string) => (url.startsWith('http') ? url : `https://${url}`);

const trimUrlSuffix = (url: string) => {
  let trimmedUrl = url;
  let trailingText = '';

  while (/[.,!?;:]$/.test(trimmedUrl)) {
    trailingText = `${trimmedUrl.slice(-1)}${trailingText}`;
    trimmedUrl = trimmedUrl.slice(0, -1);
  }

  return { trimmedUrl, trailingText };
};

const renderInlineMarkdown = (text: string, keyPrefix: string): React.ReactNode[] =>
  text
    .split(INLINE_TOKEN_RE)
    .filter(Boolean)
    .flatMap((token, index) => {
      const key = `${keyPrefix}-${index}`;
      const markdownLinkMatch = token.match(MARKDOWN_LINK_RE);

      if (markdownLinkMatch) {
        const [, label, url] = markdownLinkMatch;
        return (
          <a
            key={key}
            className="inline-link"
            href={normalizeUrl(url)}
            target="_blank"
            rel="noreferrer"
          >
            {label}
          </a>
        );
      }

      if (/^(https?:\/\/|www\.)/.test(token)) {
        const { trimmedUrl, trailingText } = trimUrlSuffix(token);
        const nodes: React.ReactNode[] = [
          <a
            key={key}
            className="inline-link"
            href={normalizeUrl(trimmedUrl)}
            target="_blank"
            rel="noreferrer"
          >
            {trimmedUrl}
          </a>,
        ];

        if (trailingText) {
          nodes.push(
            <React.Fragment key={`${key}-trailing`}>{trailingText}</React.Fragment>
          );
        }

        return nodes;
      }

      if (token.startsWith('`') && token.endsWith('`')) {
        return (
          <code key={key} className="inline-code">
            {token.slice(1, -1)}
          </code>
        );
      }

      const boldMatch = token.match(BOLD_RE);
      if (boldMatch) {
        return <strong key={key}>{renderInlineMarkdown(boldMatch[2], `${key}-bold`)}</strong>;
      }

      const italicMatch = token.match(ITALIC_RE);
      if (italicMatch) {
        return <em key={key}>{renderInlineMarkdown(italicMatch[2], `${key}-italic`)}</em>;
      }

      return <React.Fragment key={key}>{token}</React.Fragment>;
    });

const renderToken = (token: string, revealAnswers: boolean, key: string) => {
  if (token.startsWith('[[') && token.endsWith(']]')) {
    return (
      <span key={key} className="inline-chip">
        {token.slice(2, -2)}
      </span>
    );
  }

  if (token.startsWith('((') && token.endsWith('))')) {
    return (
      <span key={key} className="inline-ref">
        ↗ {token.slice(2, -2)}
      </span>
    );
  }

  const isCaretCloze = token.startsWith('^^') && token.endsWith('^^');
  const isBraceCloze = token.startsWith('{') && token.endsWith('}');

  if (isCaretCloze || isBraceCloze) {
    const text = isCaretCloze ? token.slice(2, -2) : token.slice(1, -1);
    return (
      <span
        key={key}
        className={revealAnswers ? 'cloze cloze-visible' : 'cloze'}
      >
        {revealAnswers ? text : '\u00A0'.repeat(Math.max(4, text.length))}
      </span>
    );
  }

  return token;
};

export const renderRoamText = (text: string, revealAnswers: boolean) =>
  text.split(TOKEN_RE).filter(Boolean).flatMap((token, index) => {
    if (SPECIAL_TOKEN_RE.test(token)) {
      return renderToken(token, revealAnswers, `${token}-${index}`);
    }

    return renderInlineMarkdown(token, `${token}-${index}`);
  });
