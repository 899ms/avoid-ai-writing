#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const AIDetector = require('../detector/patterns.js');
const {
  MIN_WORDS,
  MAX_WORDS,
  prepareUnits,
  normalizeUnit,
  splitUnits,
  unitsForText,
} = require('./fp-preprocess.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

const words = (count, prefix = 'Word') => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
const tokens = (text) => text.match(/\S+/gu) || [];

test('exports the agreed limits and wrapper behavior', () => {
  assert.equal(MIN_WORDS, 50);
  assert.equal(MAX_WORDS, 400);
  const text = words(50);
  assert.deepEqual(splitUnits(text), [text]);
  assert.deepEqual(unitsForText(text), [text]);
  assert.deepEqual(unitsForText(text, 'document'), [text]);
  assert.equal(normalizeUnit('One hard\nwrapped line.'), 'One hard wrapped line.');
  assert.throws(() => prepareUnits(text, 'sentence'), /unknown unit mode/);
});

test('document mode preserves token order and bypasses every paragraph filter', () => {
  for (const text of ['', 'tiny', words(401), '    const value = 1;']) {
    const result = prepareUnits(text, 'document');
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0].status, 'selected');
    assert.equal(result.decisions[0].reason, null);
    assert.deepEqual(tokens(result.normalizedText), tokens(text));
    assert.deepEqual(result.decisions[0].spans, [{ start: 0, end: text.length }]);
  }
});

test('generated whitespace matrix keeps duplicate and Unicode tokens in order', () => {
  const samples = [
    ['same', 'same', 'naïve', '東京', '🙂', 'same'],
    ['α', 'β', 'α', 'e\u0301', 'é', 'β'],
  ];
  const separators = [' ', '\n', '\n\n', '\r\n', '\r', '\t', '  \n'];
  for (const sample of samples) {
    for (let mask = 0; mask < 128; mask++) {
      let input = sample[0];
      for (let i = 1; i < sample.length; i++) input += separators[(mask + i * 3) % separators.length] + sample[i];
      const output = prepareUnits(input, 'document').normalizedText;
      assert.deepEqual(tokens(output), tokens(input), `mask ${mask}: ${JSON.stringify(input)}`);
      assert.equal(/\r/.test(output), false);
    }
  }
});

test('colon heading boundary matrix handles case, count, spacing, and line endings', () => {
  const separators = ['\n', '\n\n', '\r\n', '\r\r'];
  for (const separator of separators) {
    for (const prefix of ['Word', 'word']) {
      for (const count of [399, 400, 401]) {
        const input = `Context:${separator}${words(count, prefix)}`;
        const doc = prepareUnits(input, 'document');
        assert.equal(doc.decisions.length, 1);
        assert.equal(doc.decisions[0].status, 'selected');
        assert.deepEqual(tokens(doc.normalizedText), tokens(input));

        const para = prepareUnits(input, 'paragraph');
        const selected = para.decisions.filter((decision) => decision.status === 'selected');
        const lowercaseImmediate = (separator === '\n' || separator === '\r\n') && prefix === 'word';
        if (lowercaseImmediate) {
          assert.equal(para.decisions.some((decision) => decision.headingKind === 'colon-inferred'), false);
          assert.equal(selected.length, count === 399 ? 1 : 0);
        } else if (count === 399) {
          assert.equal(selected.length, 1);
          assert.equal(selected[0].inputWords, 400);
          assert.equal(selected[0].headingAttached, true);
          assert.equal(selected[0].headingKind, 'colon-inferred');
        } else if (count === 400) {
          assert.equal(selected.length, 1);
          assert.equal(selected[0].inputWords, 400);
          assert.equal(selected[0].headingAttached, false);
        } else {
          assert.equal(selected.length, 0);
        }
      }
    }
  }
});

test('heading attachment spans use original CRLF offsets and never duplicate a body', () => {
  const body399 = words(399);
  const attachedInput = `Context:\r\n${body399}`;
  const attached = prepareUnits(attachedInput).decisions;
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].spans, [
    { start: 0, end: 'Context:'.length },
    { start: 'Context:\r\n'.length, end: attachedInput.length },
  ]);
  assert.equal(attached[0].text, `Context:\n${body399}`);

  const body400 = words(400);
  const detachedInput = `Context:\r\n${body400}`;
  const detached = prepareUnits(detachedInput).decisions;
  assert.equal(detached.length, 2);
  assert.equal(detached[0].reason, 'heading-would-exceed-maximum');
  assert.equal(detached[1].status, 'selected');
  assert.deepEqual(detached[1].spans, [{ start: 'Context:\r\n'.length, end: detachedInput.length }]);
  assert.equal(detached.filter((decision) => decision.spans.some((span) => span.start === 'Context:\r\n'.length)).length, 1);
});

test('explicit ATX headings attach regardless of lowercase continuation', () => {
  for (const indent of ['', '   ']) {
    const input = `${indent}## Context\nlowercase ${words(397, 'body')}`;
    const result = prepareUnits(input).decisions;
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'selected');
    assert.equal(result[0].headingKind, 'atx');
    assert.equal(result[0].headingAttached, true);
    assert.match(result[0].text, /## Context\nlowercase/);
  }
  assert.equal(prepareUnits('    ## code\n' + words(50)).decisions.some((d) => d.headingKind === 'atx'), false);
});

test('two and three consecutive headings leave only the nearest attached', () => {
  for (const count of [2, 3]) {
    const headings = Array.from({ length: count }, (_, i) => `## Heading ${i + 1}`);
    const input = `${headings.join('\n')}\n${words(50)}`;
    const decisions = prepareUnits(input).decisions;
    assert.equal(decisions.length, count);
    for (let i = 0; i < count - 1; i++) {
      assert.equal(decisions[i].reason, 'unattached-heading');
      assert.equal(decisions[i].headingAttached, false);
    }
    assert.equal(decisions[count - 1].status, 'selected');
    assert.equal(decisions[count - 1].headingAttached, true);
    assert.match(decisions[count - 1].text, new RegExp(`Heading ${count}\\nWord0`));
  }

  const colonInput = `Alpha:\nBeta:\nGamma:\n${words(50)}`;
  const colonDecisions = prepareUnits(colonInput).decisions;
  assert.equal(colonDecisions.length, 3);
  assert.deepEqual(colonDecisions.map((decision) => decision.headingKind), [
    'colon-inferred', 'colon-inferred', 'colon-inferred',
  ]);
  assert.deepEqual(colonDecisions.map((decision) => decision.headingAttached), [false, false, true]);
});

test('colon inference is limited to block starts and labels its diagnostics', () => {
  const ordinary = `He said the following:\nNothing at all, and the room stayed silent. ${words(410)}`;
  const result = prepareUnits(ordinary);
  assert.ok(result.normalizedText.includes('He said the following:\nNothing at all'));
  assert.equal(result.decisions[0].headingKind, 'colon-inferred');
  assert.equal(result.decisions[0].reason, 'heading-would-exceed-maximum');
  assert.ok(result.decisions.some((decision) => decision.text.startsWith('Nothing at all')));

  const midParagraph = `This sentence begins here\nand continues with a label:\nThen finishes with ${words(50)}`;
  const mid = prepareUnits(midParagraph);
  assert.equal(mid.decisions.some((decision) => decision.headingKind === 'colon-inferred'), false);
  assert.match(mid.normalizedText, /begins here and continues with a label: Then finishes/);

  for (const source of ['- List item:', '> Quoted label:', '    config:']) {
    assert.equal(prepareUnits(`${source}\n${words(50)}`).decisions.some((d) => d.headingKind === 'colon-inferred'), false);
  }
});

test('only ordinary hard-wrapped prose is joined', () => {
  const input = [
    'Ordinary prose is hard',
    'wrapped across source lines.',
    'A Markdown break stays here.  ',
    'This remains on a new line.',
    'A backslash break stays too.\\',
    'This also remains on a new line.',
    '> quoted text keeps',
    '> every source line',
    '- list text keeps',
    '  its lazy continuation',
    '    indented code keeps spacing',
  ].join('\r\n');
  const output = normalizeUnit(input);
  assert.ok(output.startsWith('Ordinary prose is hard wrapped across source lines.'));
  assert.ok(output.includes('A Markdown break stays here.  \nThis remains'));
  assert.ok(output.includes('A backslash break stays too.\\\nThis also'));
  assert.ok(output.includes('> quoted text keeps\n> every source line'));
  assert.ok(output.includes('- list text keeps\n  its lazy continuation'));
  assert.ok(output.includes('    indented code keeps spacing'));
  assert.equal(output.includes('\r'), false);
});

test('mixed prose and five short bullets remain one eligible source body', () => {
  const intro = 'The report contains a list of the available components for this release. Each component has a corresponding entry in the inventory and a named owner on the review team. The owner checks the entry against the published release manifest before every scheduled deployment review.';
  const bullets = ['Cloud platform', 'API gateway', 'Data pipeline', 'Event stream', 'Message queue'];
  const input = `${intro}\n${bullets.map((item) => `- ${item}`).join('\n')}`;
  assert.ok(tokens(input).length >= 50);
  const result = prepareUnits(input).decisions;
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'selected');
  assert.ok(result[0].kinds.includes('prose'));
  assert.ok(result[0].kinds.includes('list'));
  for (const bullet of bullets) assert.ok(result[0].text.includes(`- ${bullet}`));

  const analyzed = AIDetector.analyzeText(result[0].text);
  assert.ok(analyzed.issues.some((issue) => issue.type === 'bullet-np-list'));

  const withBlank = `${intro}\n\n${bullets.map((item) => `- ${item}`).join('\n')}`;
  const blankResult = prepareUnits(withBlank).decisions;
  assert.equal(blankResult.length, 1);
  assert.equal(blankResult[0].status, 'selected');
  assert.ok(blankResult[0].text.includes(`${intro}\n\n- Cloud platform`));

  const twoWordBullets = ['Cloud platform', 'API gateway', 'Data pipeline', 'Event stream', 'Message queue']
    .map((item) => `- ${item}`)
    .join('\n');
  for (const proseWords of [390, 399]) {
    const over = prepareUnits(`${words(proseWords)}\n\n${twoWordBullets}`).decisions;
    assert.equal(over[0].status, 'selected');
    assert.equal(over[0].inputWords, proseWords);
    assert.equal(over[0].text, words(proseWords));
    assert.equal(over[1].reason, 'below-min');
  }
  const exact = prepareUnits(`${words(385)}\n\n${twoWordBullets}`).decisions;
  assert.equal(exact.length, 1);
  assert.equal(exact[0].status, 'selected');
  assert.equal(exact[0].inputWords, 400);

  const unicodeBullets = ['Cloud platform', 'API gateway', 'Data pipeline', 'Event stream', 'Message queue']
    .map((item) => `• ${item}`)
    .join('\n');
  const unicodeInput = `${words(40)}\n${unicodeBullets}`;
  assert.equal(tokens(unicodeInput).length, 55);
  const rawUnicodeTypes = AIDetector.analyzeText(unicodeInput).issues.map((issue) => issue.type);
  const unicodePrepared = prepareUnits(unicodeInput).decisions;
  assert.equal(unicodePrepared.length, 1);
  assert.equal(unicodePrepared[0].status, 'selected');
  assert.deepEqual(unicodePrepared[0].kinds, ['prose', 'list']);
  const preparedUnicodeTypes = AIDetector.analyzeText(unicodePrepared[0].text).issues.map((issue) => issue.type);
  assert.ok(rawUnicodeTypes.includes('bullet-np-list'));
  assert.ok(preparedUnicodeTypes.includes('bullet-np-list'));

  const indentedBullets = [
    '    * Cloud platform',
    '\t- API gateway',
    '      • Data pipeline',
    '\t+ Event stream',
    '    - Message queue',
  ].join('\n');
  const indentedInput = `${words(40)}\n${indentedBullets}`;
  const rawIndentedTypes = AIDetector.analyzeText(indentedInput).issues.map((issue) => issue.type);
  const indentedPrepared = prepareUnits(indentedInput).decisions;
  assert.equal(indentedPrepared.length, 1);
  assert.equal(indentedPrepared[0].status, 'selected');
  assert.ok(indentedPrepared[0].text.includes('\n    * Cloud platform\n\t- API gateway'));
  const preparedIndentedTypes = AIDetector.analyzeText(indentedPrepared[0].text).issues.map((issue) => issue.type);
  assert.ok(rawIndentedTypes.includes('bullet-np-list'));
  assert.ok(preparedIndentedTypes.includes('bullet-np-list'));
});

test('blank-separated list and quote continuations retain their layout', () => {
  const list = `- First item has context\n\n  continued after a blank\n\n- Second item has context\n${words(45)}`;
  const listDecision = prepareUnits(list).decisions[0];
  assert.equal(listDecision.status, 'selected');
  assert.ok(listDecision.kinds.includes('list'));
  assert.ok(listDecision.text.includes('- First item has context\n\n  continued after a blank\n\n- Second item'));

  const longFirstItem = `- ${words(398)}`;
  const shortList = ['- Cloud platform', '- API gateway', '- Data pipeline', '- Event stream', '- Message queue'].join('\n');
  const boundedList = prepareUnits(`${longFirstItem}\n\n${shortList}`).decisions;
  assert.equal(boundedList.length, 2);
  assert.equal(boundedList[0].status, 'selected');
  assert.equal(boundedList[0].inputWords, 399);
  assert.equal(boundedList[1].reason, 'below-min');

  const quote = Array.from({ length: 5 }, () => '> What surprised me most was the detailed report on migration results across three production hosts.').join('\n');
  const quoteDecision = prepareUnits(quote).decisions[0];
  assert.equal(quoteDecision.status, 'selected');
  assert.equal(quoteDecision.text, quote);
  const analyzedQuote = AIDetector.analyzeText(quoteDecision.text);
  assert.equal(analyzedQuote.tooShort, true);
  assert.equal(analyzedQuote.stats.wordCount, 0, 'the detector still observes and masks the quote structure');
});

test('quotes and thematic breaks terminate list classification without losing body structure', () => {
  const listThenQuote = [
    `- Opening item ${words(18, 'item')}`,
    `> Quoted one ${words(14, 'quote')}`,
    `> Quoted two ${words(14, 'more')}`,
  ].join('\n');
  const quoted = prepareUnits(listThenQuote).decisions;
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].status, 'selected');
  assert.deepEqual(quoted[0].kinds, ['list', 'blockquote']);
  assert.equal(quoted[0].text, listThenQuote);

  const indentedQuote = `${words(20)}\n    > Quoted one ${words(14, 'quote')}\n\t> Quoted two ${words(14, 'more')}`;
  const preparedIndentedQuote = prepareUnits(indentedQuote).decisions;
  assert.equal(preparedIndentedQuote.length, 1);
  assert.equal(preparedIndentedQuote[0].status, 'selected');
  assert.deepEqual(preparedIndentedQuote[0].kinds, ['prose', 'blockquote']);
  assert.equal(preparedIndentedQuote[0].text, indentedQuote);
  assert.equal(
    AIDetector.analyzeText(preparedIndentedQuote[0].text).stats.wordCount,
    AIDetector.analyzeText(indentedQuote).stats.wordCount,
  );

  const listThenRule = `- Opening item ${words(47)}\n---\nClosing prose stays visible.`;
  const ruled = prepareUnits(listThenRule).decisions;
  assert.equal(ruled.length, 1);
  assert.equal(ruled[0].status, 'selected');
  assert.deepEqual(ruled[0].kinds, ['list', 'thematic-break', 'prose']);
  assert.ok(ruled[0].text.includes('\n---\nClosing prose stays visible.'));
});

test('setext headings win over thematic breaks while standalone rules remain structural', () => {
  const input = `Benefits And Strategic Considerations\n=====\n\n${words(50)}`;
  const result = prepareUnits(input).decisions;
  assert.equal(result.length, 1);
  assert.equal(result[0].headingKind, 'setext');
  assert.equal(result[0].headingAttached, true);
  assert.ok(result[0].text.startsWith('Benefits And Strategic Considerations\n====='));

  const thematic = prepareUnits(`---\n${words(50)}`).decisions;
  assert.equal(thematic.some((decision) => decision.headingKind === 'setext'), false);
  assert.ok(thematic[0].kinds.includes('thematic-break'));
});

test('fences use same-marker valid closers and stay atomic across blank lines', () => {
  const ticks = '````';
  const input = [
    ticks + 'js',
    words(25, 'code'),
    '',
    '~~~',
    '```',
    '```` trailing text',
    words(25, 'more'),
    ticks,
  ].join('\r\n');
  const result = prepareUnits(input);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].status, 'selected');
  assert.deepEqual(result.decisions[0].kinds, ['fenced-code']);
  assert.ok(result.decisions[0].text.includes('\n\n~~~\n```\n```` trailing text\n'));
  assert.deepEqual(tokens(result.decisions[0].text), tokens(input));

  const unclosed = `~~~\n${words(25)}\n\n${words(25, 'tail')}`;
  const unclosedResult = prepareUnits(unclosed).decisions;
  assert.equal(unclosedResult.length, 1);
  assert.deepEqual(unclosedResult[0].kinds, ['fenced-code']);
  assert.ok(unclosedResult[0].text.endsWith('tail24'));

  const oversized = `~~~\n${words(210)}\n\n${words(210, 'tail')}\n~~~`;
  const oversizedResult = prepareUnits(oversized).decisions;
  assert.equal(oversizedResult.length, 1);
  assert.equal(oversizedResult[0].reason, 'above-max');
  assert.deepEqual(oversizedResult[0].kinds, ['fenced-code']);
});

test('indented code stays structural and uses only the shared word limits', () => {
  const code = `${words(30, '    code')}\n\n    ${words(30, 'more')}`;
  const result = prepareUnits(code).decisions;
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'selected');
  assert.equal(result[0].reason, null);
  assert.ok(result[0].text.includes('\n\n    more0'));

  const withHeading = prepareUnits(`## Example\n    ${words(55, 'code')}`).decisions;
  assert.equal(withHeading.length, 1);
  assert.equal(withHeading[0].status, 'selected');
  assert.equal(withHeading[0].headingAttached, true);

  const lazyContinuation = `${words(25)}\n    continuation ${words(25, 'tail')}`;
  const lazy = prepareUnits(lazyContinuation).decisions;
  assert.equal(lazy.length, 1);
  assert.equal(lazy[0].status, 'selected');
  assert.deepEqual(lazy[0].kinds, ['prose']);
  assert.equal(lazy[0].text, `${words(25)} continuation ${words(25, 'tail')}`);
});

test('all candidate decisions carry the complete stable shape', () => {
  const input = `Context:\n\nshort body\n\n${words(401)}`;
  const decisions = prepareUnits(input).decisions;
  assert.ok(decisions.length >= 2);
  for (const decision of decisions) {
    assert.deepEqual(Object.keys(decision), [
      'text', 'spans', 'kinds', 'headingAttached', 'headingKind',
      'inputWords', 'status', 'reason',
    ]);
    assert.ok(['selected', 'skipped'].includes(decision.status));
    assert.equal(decision.status === 'selected', decision.reason === null);
    for (const span of decision.spans) {
      assert.ok(Number.isInteger(span.start) && Number.isInteger(span.end));
      assert.ok(span.start >= 0 && span.end <= input.length && span.start <= span.end);
    }
  }
});

process.stdout.write(`\n${passed} fp-preprocess tests passed\n`);
