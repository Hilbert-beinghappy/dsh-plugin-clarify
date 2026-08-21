import {
  ClarifyError,
  UnauthorizedInferenceEngine,
  type InferenceEngine,
  type InferenceInput,
  type InferenceRepairInput,
  type ModelInference,
} from './types.ts'

/** Stable process-local inference slot owned by the main Clarify plugin fiber. */
export class AcceptanceInferenceController implements InferenceEngine {
  private readonly unauthorized = new UnauthorizedInferenceEngine()
  private active?: { engine: InferenceEngine; token: symbol }

  async infer(input: InferenceInput, signal: AbortSignal): Promise<ModelInference | string> {
    return await this.current().infer(input, signal)
  }

  async repair(input: InferenceRepairInput, signal: AbortSignal): Promise<string> {
    const engine = this.current()
    if (typeof engine.repair !== 'function') {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'active inference engine does not support repair', 'configuration')
    }
    return await engine.repair(input, signal)
  }

  activate(engine: InferenceEngine): () => void {
    if (this.active) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'accepted Host inference is already composed', 'conflict')
    }
    const token = Symbol('clarify-accepted-inference')
    this.active = { engine, token }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.active?.token === token) this.active = undefined
    }
  }

  isActive(): boolean {
    return this.active !== undefined
  }

  private current(): InferenceEngine {
    return this.active?.engine ?? this.unauthorized
  }
}
