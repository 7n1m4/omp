export function getMissionWorkerModel(): string | undefined {
	return process.env.MISSION_WORKER_MODEL ?? process.env.DROID_WORKER_MODEL;
}

export function getMissionWorkerReasoningEffort(): string | undefined {
	return process.env.MISSION_WORKER_REASONING_EFFORT ?? process.env.DROID_WORKER_REASONING_EFFORT;
}

export function getMissionValidationWorkerModel(): string | undefined {
	return process.env.MISSION_VALIDATION_WORKER_MODEL ?? process.env.DROID_VALIDATION_WORKER_MODEL;
}

export function getMissionValidationWorkerReasoningEffort(): string | undefined {
	return (
		process.env.MISSION_VALIDATION_WORKER_REASONING_EFFORT ?? process.env.DROID_VALIDATION_WORKER_REASONING_EFFORT
	);
}
