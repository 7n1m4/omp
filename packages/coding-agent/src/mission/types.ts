export type MissionPhase = "proposed" | "approved" | "running" | "completed" | "paused";

export interface MissionState {
	state: MissionPhase;
	pauseReason: string | null;
	lastReviewedHandoffCount: number;
	isLegacyMissionMode: boolean;
}

export type MissionFeatureStatus = "pending" | "in_progress" | "completed";

export interface MissionFeature {
	id: string;
	title: string;
	description: string;
	status: MissionFeatureStatus;
	owner: string | null;
	handoffId: string | null;
	createdAt: string;
	updatedAt: string;
	attempts?: number;
	maxRetries?: number;
	backoff?: number;
}

export interface MissionFeaturesFile {
	features: MissionFeature[];
	initialFeatureCount: number;
	scopeGrowthMultiplier: number;
}

export type ValidationStatus = "pass" | "fail" | "skipped";
export type ValidationOverallStatus = "pending" | "passing" | "failing";

export interface ValidationResult {
	validator: string;
	featureId: string;
	status: ValidationStatus;
	findings: string[];
	runAt: string;
}

export interface ValidationState {
	validators: string[];
	lastRunAt: string | null;
	results: ValidationResult[];
	overallStatus: ValidationOverallStatus;
}

export interface WorkerHandoff {
	successState: "success" | "failure";
	summary: string;
	artifacts: string[];
	whatWasImplemented?: string;
	whatWasLeftUndone?: string;
	verification?: string;
	commitId?: string;
	repoPath?: string;
	attempts?: number;
	retryCount?: number;
	lastError?: string;
}

export type ProgressLogEntry =
	| {
			type: "worker_started";
			workerId: string;
			featureId: string;
			timestamp: string;
			workerSessionId?: string;
			modelId?: string;
			reasoningEffort?: string;
			validationModelId?: string;
			substitutedFromModelId?: string;
	  }
	| {
			type: "worker_completed";
			workerId: string;
			featureId: string;
			handoff: WorkerHandoff;
			timestamp: string;
			workerSessionId?: string;
			modelId?: string;
			reasoningEffort?: string;
			validationModelId?: string;
			substitutedFromModelId?: string;
	  }
	| { type: "worker_selected_feature"; workerId: string; featureId: string; timestamp: string }
	| { type: "mission_paused"; pauseReason: string; timestamp: string };

export interface MissionModelSettings {
	workerModel?: string;
	workerReasoningEffort?: string;
	validationWorkerModel?: string;
	[key: string]: unknown;
}

export interface MissionAccessResult {
	allowed: boolean;
	reason?: string;
}
