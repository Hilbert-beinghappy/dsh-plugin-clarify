import type { InferenceEngine, ModelAsk } from '../../src/types.ts'

export declare const STUB_ASKS: readonly ModelAsk[]

export declare class StubInferenceEngine implements InferenceEngine {
  infer: InferenceEngine['infer']
}
