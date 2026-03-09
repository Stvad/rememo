import { render, screen } from '@testing-library/react';
import { renderRoamText } from '~/standalone/lib/text';

describe('renderRoamText', () => {
  test('renders bare urls as clickable links', () => {
    render(<div>{renderRoamText('See https://example.com/docs for details.', true)}</div>);

    const link = screen.getByRole('link', { name: 'https://example.com/docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
  });

  test('renders markdown links as clickable links with labels', () => {
    render(<div>{renderRoamText('Open [Example](https://example.com).', true)}</div>);

    const link = screen.getByRole('link', { name: 'Example' });
    expect(link.getAttribute('href')).toBe('https://example.com');
  });

  test('keeps roam page refs rendered alongside markdown styling', () => {
    render(<div>{renderRoamText('Review [[memo]] and **bold** notes', true)}</div>);

    expect(screen.getByText('memo').classList.contains('inline-chip')).toBe(true);
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong');
  });
});
