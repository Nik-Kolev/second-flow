import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClarifyingQuestion, isUserPushback } from '../heuristics.js';

// Small, documented-as-provisional tables — not exhaustive, see the module comment.

test('isUserPushback matches common correction/rejection phrasing', () => {
	assert.equal(isUserPushback("No, that's wrong, revert that."), true);
	assert.equal(isUserPushback('Please undo that change.'), true);
	assert.equal(isUserPushback('Why did you delete the file?'), true);
	assert.equal(isUserPushback("You shouldn't have committed that."), true);
});

test('isUserPushback returns false for ordinary requests', () => {
	assert.equal(isUserPushback('Please add a login button.'), false);
	assert.equal(isUserPushback('Thanks, that looks good.'), false);
});

test('isClarifyingQuestion matches a question starting with a question word', () => {
	assert.equal(isClarifyingQuestion('What do you mean by that?'), true);
	assert.equal(isClarifyingQuestion('Can you explain this part?'), true);
	assert.equal(isClarifyingQuestion('  Why is this failing?  '), true);
});

test('isClarifyingQuestion returns false for a non-question or a non-starter question', () => {
	assert.equal(isClarifyingQuestion('Add a login button.'), false);
	assert.equal(isClarifyingQuestion('Looks good?'), false);
});
