/**
 * Where angle-bracketed text actually goes.
 *
 * A bug report ("Vikunja ate my <div>") cost a day of blaming the write path.
 * The write path is innocent: `sanitizeUserText` only removes C0/C1 control
 * chars, so markup reaches the server byte-for-byte. The stripping is OUR OWN
 * READ RENDERER, `htmlToPlainText`, which every task read passes through —
 * including a single-task `get`, because TaskResponseFormatter wraps one task
 * as `{ tasks: [task] }` with `taskTableOptions.showNotes`.
 *
 * These tests pin that split so it is never re-litigated.
 */

import { describe, it, expect } from '@jest/globals';
import { sanitizeUserText } from '../../src/utils/validation';
import { htmlToPlainText } from '../../src/utils/html-text';
import { formatSuccessMessage } from '../../src/utils/simple-response';
import type { Task } from '../../src/types/vikunja';

/** The exact text from the bug report. */
const DIV_SAMPLE = 'wrap it in a <div> then close </div> - ok?';

/** A description exercising both documented collapses: an anchor and a list. */
const ANCHOR_AND_LIST =
  '<p>see <a href="https://vikunja.io/docs">the docs</a></p><ul><li>first</li><li>second</li></ul>';

/**
 * Render one task through the real formatter and return its Notes cell.
 * This is the path a `vikunja_task_crud get` response takes.
 */
function notesCell(description: string): string {
  const content = formatSuccessMessage(
    'get',
    'Task retrieved',
    {
      tasks: [{ id: 1, project_id: 3, title: 'T', description }] as Task[],
      taskTableOptions: { showNotes: true },
    },
  );
  const row = content.split('\n').find((line) => line.startsWith('| 1 | '));
  if (row === undefined) {
    throw new Error(`no task row rendered:\n${content}`);
  }
  const cells = row.slice(2, -2).split(' | ');
  const notes = cells[cells.length - 1];
  if (notes === undefined) {
    throw new Error(`no Notes cell in row: ${row}`);
  }
  return notes;
}

describe('the WRITE path never strips markup', () => {
  it('sanitizeUserText returns the <div> sample byte-identical', () => {
    expect(sanitizeUserText(DIV_SAMPLE)).toBe(DIV_SAMPLE);
  });

  it('sanitizeUserText leaves angle brackets, ampersands, quotes, slashes and equals alone', () => {
    const samples = [
      '<div class="note">kept</div>',
      'a < b && c > d',
      'href="https://vikunja.io/docs" rel=\'noopener\'',
      'up/down = presets, left/right = time of day',
      '&amp; stays &amp;, not &',
      '</p><script>not executed, just text</script>',
    ];
    for (const sample of samples) {
      expect(sanitizeUserText(sample)).toBe(sample);
    }
  });
});

describe('the READ renderer is what drops the tags', () => {
  it('htmlToPlainText strips the <div> the write path stored intact', () => {
    // THIS is the strip people mistake for storage loss. The bytes are still on
    // the server; `vikunja_task_crud get` with `raw: true` is the verbatim read.
    // (The trailing "- ok?" is the author's own hyphen, not a generated bullet —
    // it starts a line only because </div> became a newline.)
    expect(htmlToPlainText(DIV_SAMPLE)).toBe('wrap it in a then close\n- ok?');
    expect(htmlToPlainText(DIV_SAMPLE)).not.toBe(sanitizeUserText(DIV_SAMPLE));
  });

  it('collapses an anchor to "text (url)"', () => {
    expect(htmlToPlainText('see <a href="https://vikunja.io/docs">the docs</a> now')).toBe(
      'see the docs (https://vikunja.io/docs) now',
    );
  });

  it('collapses an anchor to just the url when the label equals it', () => {
    expect(htmlToPlainText('<a href="https://vikunja.io">https://vikunja.io</a>')).toBe(
      'https://vikunja.io',
    );
  });

  it('turns <li> into a "- " bullet', () => {
    expect(htmlToPlainText('<ul><li>first</li><li>second</li></ul>')).toBe('- first\n- second');
  });

  it('turns block tags and <br> into newlines', () => {
    expect(htmlToPlainText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToPlainText('one<br>two')).toBe('one\ntwo');
  });

  it('decodes the six named entities', () => {
    expect(
      htmlToPlainText('Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b'),
    ).toBe('Tom & Jerry <tag> "q" \'s\' a b');
  });

  it('drops zero-width characters', () => {
    // Written as escapes so the source stays pure ASCII: ZWSP, ZWNJ, ZWJ, BOM.
    expect(htmlToPlainText('a\u200Bb\u200Cc\u200Dd\uFEFFe')).toBe('abcde');
  });

  it('collapses runs of spaces and tabs', () => {
    expect(htmlToPlainText('a     b\t\tc')).toBe('a b c');
  });
});

describe('the rendered form is LOSSY — never write it back', () => {
  it('cannot reconstruct the markup it came from', () => {
    const rendered = htmlToPlainText(ANCHOR_AND_LIST);

    expect(rendered).not.toBe(ANCHOR_AND_LIST);
    expect(rendered).not.toContain('href');
    expect(rendered).not.toContain('<li>');
    // Re-rendering is stable, which is exactly why the loss is silent: storing
    // this back looks fine on the next read, and the anchor is gone for good.
    expect(htmlToPlainText(rendered)).toBe(rendered);
  });

  it('eats an escaped entity on the second pass, so a write-back corrupts text', () => {
    // Stored text meaning the literal characters "&amp;" (an author writing about
    // entities). One render already turns it into "&"-markup; a second destroys it.
    const stored = 'Tom &amp;amp; Jerry';
    const once = htmlToPlainText(stored);

    expect(once).toBe('Tom &amp; Jerry');
    expect(htmlToPlainText(once)).toBe('Tom & Jerry');
    expect(htmlToPlainText(once)).not.toBe(once);
  });
});

describe('simple-response renders Notes through the shared htmlToPlainText', () => {
  it('emits a Notes column when showNotes is set', () => {
    const content = formatSuccessMessage(
      'get',
      'Task retrieved',
      {
        tasks: [{ id: 1, project_id: 3, title: 'T', description: ANCHOR_AND_LIST }] as Task[],
        taskTableOptions: { showNotes: true },
      },
    );

    expect(content).toContain('| ID | Task | Notes |');
  });

  it('renders a single-line description as exactly htmlToPlainText(description)', () => {
    // Extraction guard: simple-response imports htmlToPlainText from
    // ./html-text rather than declaring its own copy, so the cell is the
    // renderer's output verbatim.
    const description = '<p>see <a href="https://vikunja.io/docs">the docs</a></p>';

    expect(notesCell(description)).toBe(htmlToPlainText(description));
    expect(notesCell(description)).toBe('see the docs (https://vikunja.io/docs)');
  });

  it('renders an anchor + list description as htmlToPlainText, flattened for the cell', () => {
    // Same renderer output; the only delta is the markdown-table cell escape,
    // which turns its newlines into " / " so the row stays one line.
    const expected = htmlToPlainText(ANCHOR_AND_LIST).replace(/\s*\n+\s*/g, ' / ');

    expect(notesCell(ANCHOR_AND_LIST)).toBe(expected);
    expect(notesCell(ANCHOR_AND_LIST)).toBe(
      'see the docs (https://vikunja.io/docs) / - first / - second',
    );
  });
});
