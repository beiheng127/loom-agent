import type { LanguageModel } from "ai";
import type { ModelAvailability, ModelConfig, ModelProviderId } from "../types/index.js";
export declare const BUILTIN_MODELS: ModelConfig[];
export declare function listModels(): ModelConfig[];
export declare function getModelConfig(id: string): ModelConfig;
export declare function isModelKeyConfigured(config: ModelConfig): boolean;
export declare function describeModelAvailability(config: ModelConfig): ModelAvailability;
export declare function listModelsWithAvailability(): Array<ModelConfig & {
    availability: ModelAvailability;
}>;
/** 探测本机 Ollama（/api/tags），超时约 1.5s */
export declare function probeOllama(baseURL?: string): Promise<{
    ok: boolean;
    detail: string;
    modelCount: number;
}>;
/** Models / meta 用：对 Ollama 做实时探测 */
export declare function listModelsWithAvailabilityAsync(): Promise<Array<ModelConfig & {
    availability: ModelAvailability;
}>>;
export declare function resolveLanguageModel(config: ModelConfig): LanguageModel | null;
export declare function providerLabel(id: ModelProviderId): string;
/** 第一个就绪的非 mock 模型（Composer 默认优先） */
export declare function preferredComposerModelId(models?: Array<ModelConfig & {
    availability: ModelAvailability;
}>): string | null;
/**
 * Plan Worker 角色 → 真模型 id。
 * 无任一真模型就绪时返回 null（调用方回落 mock）。
 */
export declare function preferredRealModelRoles(models?: Array<ModelConfig & {
    availability: ModelAvailability;
}>): {
    reader: string;
    auditor: string;
    editor: string;
} | null;
/**
 * 可自动选用的真模型：
 * - DeepSeek / OpenAI：需 Key
 * - Ollama：探测可达，或 LOOM_USE_OLLAMA=1
 */
export declare function listAutoSelectableRealModels(models?: (ModelConfig & {
    availability: ModelAvailability;
})[]): Array<ModelConfig & {
    availability: ModelAvailability;
}>;
export declare function listAutoSelectableRealModelsAsync(): Promise<Array<ModelConfig & {
    availability: ModelAvailability;
}>>;
