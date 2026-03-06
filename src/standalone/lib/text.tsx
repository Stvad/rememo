import React from 'react';

const TOKEN_RE = /(\^\^.+?\^\^|\{.+?\}|\[\[.+?\]\]|\(\(.+?\)\))/g;
const SPECIAL_TOKEN_RE = /^(\^\^.+?\^\^|\{.+?\}|\[\[.+?\]\]|\(\(.+?\)\))$/;

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
  text.split(TOKEN_RE).filter(Boolean).map((token, index) => {
    if (SPECIAL_TOKEN_RE.test(token)) {
      return renderToken(token, revealAnswers, `${token}-${index}`);
    }

    return <React.Fragment key={`${token}-${index}`}>{token}</React.Fragment>;
  });
