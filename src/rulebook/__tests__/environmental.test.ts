import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractEnvironmentalRuleBlocks } from '../environmental.js';
import type { AttachmentBucket } from '../types.js';

function emptyBucket(overrides: Partial<AttachmentBucket> = {}): AttachmentBucket {
	return {
		hookSuccess: [],
		skillListing: [],
		deferredToolsDelta: [],
		agentListingDelta: [],
		mcpInstructionsDelta: [],
		outputStyle: [],
		unknown: [],
		...overrides,
	};
}

test('returns [] when every bucket is empty', () => {
	assert.deepEqual(extractEnvironmentalRuleBlocks(emptyBucket()), []);
});

test('extracts an mcp block from an add-only delta', () => {
	const bucket = emptyBucket({
		mcpInstructionsDelta: [
			{ addedNames: ['context7'], addedBlocks: ['Use this server for docs.'] },
		],
	});

	const blocks = extractEnvironmentalRuleBlocks(bucket);

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].origin, 'transcript');
	assert.equal(blocks[0].layer, 'environmental');
	assert.equal(blocks[0].source, 'context7');
	assert.equal(blocks[0].text, 'Use this server for docs.');
});

test('nets out an mcp server that was later removed in the same session', () => {
	const bucket = emptyBucket({
		mcpInstructionsDelta: [
			{ addedNames: ['context7'], addedBlocks: ['Use this server for docs.'] },
			{ removedNames: ['context7'] },
		],
	});

	assert.deepEqual(extractEnvironmentalRuleBlocks(bucket), []);
});

test('a later re-add after a removal in an earlier delta is still active', () => {
	const bucket = emptyBucket({
		mcpInstructionsDelta: [
			{ addedNames: ['context7'], addedBlocks: ['v1 instructions'] },
			{ removedNames: ['context7'] },
			{ addedNames: ['context7'], addedBlocks: ['v2 instructions'] },
		],
	});

	const blocks = extractEnvironmentalRuleBlocks(bucket);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].text, 'v2 instructions');
});

test('two unnamed mcp delta entries do not collide on the fallback key', () => {
	const bucket = emptyBucket({
		mcpInstructionsDelta: [
			{ addedBlocks: ['server A instructions'] },
			{ addedBlocks: ['server B instructions'] },
		],
	});

	const blocks = extractEnvironmentalRuleBlocks(bucket);
	const texts = blocks.map((b) => b.text).sort();

	assert.equal(blocks.length, 2);
	assert.deepEqual(texts, ['server A instructions', 'server B instructions']);
});

test('extracts a skill-listing block', () => {
	const bucket = emptyBucket({
		skillListing: [
			{ content: 'Available skills: deploy, review', names: ['deploy', 'review'] },
		],
	});

	const blocks = extractEnvironmentalRuleBlocks(bucket);
	const block = blocks[0];

	assert.equal(blocks.length, 1);
	if (block.origin !== 'transcript') {
		assert.fail('expected a transcript-origin block');
	}
	assert.equal(block.sourceKind, 'skill');
	assert.equal(block.text, 'Available skills: deploy, review');
});

test('extracts an output-style block', () => {
	const bucket = emptyBucket({ outputStyle: [{ style: 'Explanatory' }] });

	const blocks = extractEnvironmentalRuleBlocks(bucket);
	const block = blocks[0];

	assert.equal(blocks.length, 1);
	if (block.origin !== 'transcript') {
		assert.fail('expected a transcript-origin block');
	}
	assert.equal(block.sourceKind, 'output-style');
	assert.equal(block.text, 'Explanatory');
});

test('deferredToolsDelta, agentListingDelta, and unknown never contribute blocks', () => {
	const bucket = emptyBucket({
		deferredToolsDelta: [{ addedNames: ['Foo'] }],
		agentListingDelta: [{ addedTypes: ['Bar'] }],
		unknown: [{ attachmentType: 'mystery' }],
	});

	assert.deepEqual(extractEnvironmentalRuleBlocks(bucket), []);
});
