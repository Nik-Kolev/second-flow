import type {
	AttachmentBucket,
	HookSuccessAttachment,
	McpInstructionsDeltaAttachment,
} from '../parser/types.js';

export type { AttachmentBucket, HookSuccessAttachment, McpInstructionsDeltaAttachment };

// 'managed' (enterprise/managed-policy CLAUDE.md) is named in the design doc's vocabulary but no
// v1 discovery function produces it — kept in the union so downstream consumers can already
// switch over the full intended vocabulary exhaustively.
export type RulebookLayer = 'managed' | 'user' | 'project' | 'environmental';

interface RuleBlockBase {
	text: string;
}

export interface FileRuleBlock extends RuleBlockBase {
	origin: 'file';
	layer: Extract<RulebookLayer, 'managed' | 'user' | 'project'>; // v1 only ever emits 'user' or 'project'
	source: string;
}

export interface HookRuleBlock extends RuleBlockBase {
	origin: 'hook';
	layer: Extract<RulebookLayer, 'user'>;
	source: string;
	meta: { hookName?: string; hookEvent: string; uuid?: string; timestamp?: string };
}

export interface EnvironmentalRuleBlock extends RuleBlockBase {
	origin: 'transcript';
	layer: Extract<RulebookLayer, 'environmental'>;
	sourceKind: 'mcp' | 'skill' | 'output-style';
	source: string;
	meta?: { uuid?: string; timestamp?: string; names?: string[] };
}

export type RuleBlock = FileRuleBlock | HookRuleBlock | EnvironmentalRuleBlock;

export interface RulebookContext {
	cwd?: string;
}

export interface RulebookDiscoveryOptions {
	/** Overrides os.homedir() when resolving the global CLAUDE.md path. Test-injection only. */
	homeDir?: string;
}

export interface FileDiscoveryResult {
	blocks: RuleBlock[];
	/** True iff the file exists and was read, independent of whether it produced a non-empty block. */
	found: boolean;
}

export interface RulebookResolution {
	blocks: RuleBlock[];
	sources: {
		global: { path: string; found: boolean };
		project: { path: string | null; found: boolean };
		hook: { count: number };
		environmental: { count: number };
	};
}
